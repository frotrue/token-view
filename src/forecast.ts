import type { Dashboard, DailyRow, FineRow, HourlyRow, LimitSnap, Source } from "./api";
import { totalTokens } from "./api";
import { addDays, dayKey, parseDay } from "./format";

const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------- uncertainty

export interface Quantiles {
  p10: number;
  p50: number;
  p90: number;
}

/**
 * Empirical spread of "how much gets used in the next `len` units": the sums of every
 * contiguous `len`-long stretch of the user's own recent history. No distribution is
 * assumed; quiet nights and busy afternoons are both in the sample.
 */
export function windowQuantiles(values: number[], len: number): Quantiles | null {
  if (len <= 0 || values.length < len || values.length < 2) return null;
  const sums: number[] = [];
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    acc += values[i];
    if (i >= len) acc -= values[i - len];
    if (i >= len - 1) sums.push(acc);
  }
  sums.sort((a, b) => a - b);
  const q = (p: number) => sums[Math.min(sums.length - 1, Math.max(0, Math.round(p * (sums.length - 1))))];
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}

/** Hourly cost for the last `hours` full hours (oldest first), zero-filled. */
export function hourlySeries(hourly: HourlyRow[], source: Source | "all", hours: number, now = Date.now()): number[] {
  const end = Math.floor(now / HOUR) * HOUR; // current (partial) hour excluded
  const start = end - hours * HOUR;
  const out = new Array<number>(hours).fill(0);
  for (const r of hourly) {
    if (source !== "all" && r.source !== source) continue;
    if (r.hour < start || r.hour >= end) continue;
    out[Math.floor((r.hour - start) / HOUR)] += r.cost;
  }
  return out;
}

// ---------------------------------------------------------------- rate limits

export interface LimitPoint {
  ts: number;
  pct: number;
}

export interface LimitView {
  key: string;
  source: Source;
  title: string;
  windowLabel: string;
  plan: string;
  windowMinutes: number;
  startAt: number;
  resetsAt: number;
  points: LimitPoint[];
  lastSnapTs: number;
  lastPct: number;
  /** Current usage, extrapolated from spend since the last snapshot when stale. */
  nowPct: number;
  estimated: boolean;
  isReset: boolean;
  /** "live": snapshot from this window; "calibrated": estimated from past windows only. */
  basis: "live" | "calibrated";
  /** No request since the last short window ended, so no window is running. */
  idle: boolean;
  /** %/hour over the whole window so far. */
  avgRate: number;
  /** %/hour over the recent pace window (1h for 5h limits, 24h for weekly). */
  recentRate: number;
  recentLabel: string;
  exhaustAt: number | null;
  exhaustAtAvg: number | null;
  atReset: number;
  atResetAvg: number;
  /** 10th–90th percentile of usage at reset, from the user's own pacing history. */
  atResetRange: [number, number] | null;
  /** API-equivalent USD that 100% of this window corresponds to (learned). */
  usdPerFull: number | null;
  status: "ok" | "warn" | "danger" | "idle";
  history: { resetsAt: number; finalPct: number }[];
}

function windowLabel(win: string, minutes: number): string {
  const base = minutes === 300 ? "5시간" : minutes === 10080 ? "주간" : minutes >= 1440 ? `${Math.round(minutes / 1440)}일` : `${Math.round(minutes / 60)}시간`;
  const lower = win.toLowerCase();
  const tag = lower.includes("opus") ? " · Opus" : lower.includes("sonnet") ? " · Sonnet" : lower.includes("fable") ? " · Fable" : "";
  return base + tag;
}

function costBetween(fine: FineRow[], source: Source, from: number, to: number): number {
  let c = 0;
  for (const r of fine) {
    if (r.source !== source) continue;
    const mid = r.t + 300_000; // bucket midpoint
    if (mid >= from && mid < to) c += r.cost;
  }
  return c;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Start of the window containing `now`, chaining windows from the first request after `from`. */
function activityWindowStart(fine: FineRow[], source: Source, from: number, winMs: number, now: number): number | null {
  const active = fine.filter((r) => r.source === source && r.requests > 0 && r.t + 600_000 > from).map((r) => Math.max(r.t, from));
  active.sort((a, b) => a - b);
  let i = 0;
  if (!active.length) return null;
  let start = active[0];
  while (start + winMs <= now) {
    while (i < active.length && active[i] < start + winMs) i++;
    if (i >= active.length) return null; // no request since that window ended
    start = active[i];
  }
  return start;
}

function clusterWindows(snaps: LimitSnap[]): LimitSnap[][] {
  const out: LimitSnap[][] = [];
  for (const s of snaps) {
    const cur = out[out.length - 1];
    if (cur && Math.abs(cur[cur.length - 1].resetsAt - s.resetsAt) < 10 * 60_000) cur.push(s);
    else out.push([s]);
  }
  return out;
}

export function buildLimitViews(d: Dashboard): LimitView[] {
  const now = Date.now();
  const groups = new Map<string, LimitSnap[]>();
  for (const s of d.limits) {
    const key = `${s.source}|${s.limitId}|${s.win}|${s.windowMinutes}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const views: LimitView[] = [];
  for (const [key, all] of groups) {
    all.sort((a, b) => a.ts - b.ts);
    const last = all[all.length - 1];
    const winMs = last.windowMinutes * 60_000;
    if (!last.windowMinutes) continue;
    const clusters = clusterWindows(all);
    const curCluster = clusters[clusters.length - 1];

    // "% per USD" observed in each window. A limit-hit record is a clean 100% point, so
    // even without live snapshots the current window can be estimated from spend.
    const calib: number[] = [];
    for (const c of clusters) {
      const top = c.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
      const spent = costBetween(d.fine, top.source, top.resetsAt - winMs, top.ts);
      if (top.usedPct >= 3 && spent > 1) calib.push(top.usedPct / spent);
    }
    const calibRatio = median(calib);
    const maxAge = calibRatio !== null ? 35 * DAY : Math.max(winMs, DAY) + DAY;
    if (now - last.ts > maxAge) continue; // limit kind no longer in use

    const history = clusters
      .slice(0, -1)
      .map((c) => ({ resetsAt: c[c.length - 1].resetsAt, finalPct: Math.max(...c.map((x) => x.usedPct)) }));
    const isReset = last.resetsAt > 0 && last.resetsAt <= now;
    if (isReset) history.push({ resetsAt: last.resetsAt, finalPct: Math.max(...curCluster.map((x) => x.usedPct)) });

    let resetsAt: number;
    let idle = false;
    if (!isReset) resetsAt = last.resetsAt;
    else if (last.windowMinutes <= 300) {
      // Short windows start at the first request after a reset, so follow activity.
      const start = activityWindowStart(d.fine, last.source, last.resetsAt, winMs, now);
      idle = start === null;
      resetsAt = (start ?? now) + winMs;
    } else resetsAt = last.resetsAt + winMs * Math.ceil((now - last.resetsAt) / winMs || 1);
    const startAt = resetsAt - winMs;
    const points: LimitPoint[] = isReset ? [] : curCluster.map((s) => ({ ts: s.ts, pct: s.usedPct }));

    let ratio: number | null = null;
    if (!isReset && last.usedPct >= 1) {
      const spent = costBetween(d.fine, last.source, startAt, last.ts);
      if (spent > 0.5) ratio = last.usedPct / spent;
    }
    ratio ??= calibRatio;

    const lastPct = isReset ? 0 : last.usedPct;
    const lastTs = isReset ? startAt : last.ts;
    const sinceCost = costBetween(d.fine, last.source, Math.max(lastTs, startAt), now);
    const estimated = ratio !== null && sinceCost > 0 && now - lastTs > 2 * 60_000;
    const nowPct = Math.min(100, lastPct + (estimated ? ratio! * sinceCost : 0));

    const elapsedH = Math.max((now - startAt) / HOUR, 1 / 60);
    const avgRate = nowPct / elapsedH;
    const recentMs = Math.min(winMs / 5, DAY);
    const recentFrom = Math.max(now - recentMs, startAt);
    const recentH = Math.max((now - recentFrom) / HOUR, 1 / 60);
    let recentRate: number;
    if (ratio !== null) {
      recentRate = (ratio * costBetween(d.fine, last.source, recentFrom, now)) / recentH;
    } else {
      const before = [...points].reverse().find((p) => p.ts <= recentFrom) ?? { ts: startAt, pct: 0 };
      recentRate = Math.max(0, (nowPct - before.pct) / Math.max((now - before.ts) / HOUR, 1 / 60));
    }

    const hoursLeft = Math.max(0, (resetsAt - now) / HOUR);
    const proj = (rate: number) => {
      const atReset = nowPct + rate * hoursLeft;
      let exhaustAt: number | null = null;
      if (nowPct >= 100) exhaustAt = now;
      else if (rate > 0) {
        const t = now + ((100 - nowPct) / rate) * HOUR;
        if (t < resetsAt) exhaustAt = t;
      }
      return { atReset, exhaustAt };
    };
    const r = proj(recentRate);
    const a = proj(avgRate);
    let atResetRange: [number, number] | null = null;
    if (ratio !== null && hoursLeft > 0 && !idle) {
      const q = windowQuantiles(hourlySeries(d.hourly, last.source, 28 * 24, now), Math.max(1, Math.ceil(hoursLeft)));
      if (q) atResetRange = [nowPct + ratio * q.p10, nowPct + ratio * q.p90];
    }

    let status: LimitView["status"] = "ok";
    if (nowPct >= 100 || r.exhaustAt !== null) status = "danger";
    else if (r.atReset >= 80 || a.atReset >= 90) status = "warn";
    else if ((recentRate === 0 && nowPct < 1) || idle) status = "idle";

    views.push({
      key,
      source: last.source,
      title: last.source === "claude" ? "Claude" : "Codex",
      windowLabel: windowLabel(last.win, last.windowMinutes),
      plan: [...all].reverse().find((s) => s.plan)?.plan ?? "",
      windowMinutes: last.windowMinutes,
      startAt,
      resetsAt,
      points,
      lastSnapTs: last.ts,
      lastPct,
      nowPct,
      estimated,
      isReset,
      basis: isReset ? "calibrated" : "live",
      idle,
      avgRate,
      recentRate,
      recentLabel: recentMs >= DAY ? "최근 24시간" : `최근 ${Math.round(recentMs / 60_000)}분`,
      exhaustAt: r.exhaustAt,
      exhaustAtAvg: a.exhaustAt,
      atReset: r.atReset,
      atResetAvg: a.atReset,
      atResetRange,
      usdPerFull: ratio ? 100 / ratio : null,
      status,
      history: history.slice(-6),
    });
  }
  const order = (v: LimitView) => (v.source === "claude" ? 0 : 1) * 100000 + v.windowMinutes;
  return views.sort((x, y) => order(x) - order(y));
}

// ---------------------------------------------------------------- spend / tokens

export type Metric = "cost" | "tokens";
export type SourceFilter = "all" | Source;

export const metricOf = (r: DailyRow, m: Metric) => (m === "cost" ? r.cost : totalTokens(r));

export function dailySeries(daily: DailyRow[], metric: Metric, source: SourceFilter): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of daily) {
    if (source !== "all" && r.source !== source) continue;
    m.set(r.date, (m.get(r.date) ?? 0) + metricOf(r, metric));
  }
  return m;
}

export interface Projection {
  today: number;
  yesterday: number;
  mtd: number;
  avg7: number;
  prevAvg7: number;
  avg30: number;
  /** Expected value for the rest of today + remaining month days. */
  projectedMonth: number;
  /** 10th–90th percentile month-end total from historical day-to-day variation. */
  monthRange: [number, number] | null;
  next7: number;
  next30: number;
  next90: number;
  firstDate: string | null;
  budget: number | null;
  budgetHit: { date: string; already: boolean } | null;
}

function avgDays(series: Map<string, number>, end: Date, n: number, firstDate: string | null): number {
  // Average over the n full days before `end`, but never over days before the data starts.
  let sum = 0;
  let days = 0;
  for (let i = 1; i <= n; i++) {
    const k = dayKey(addDays(end, -i));
    if (firstDate && k < firstDate) break;
    sum += series.get(k) ?? 0;
    days++;
  }
  return days ? sum / days : 0;
}

export function project(series: Map<string, number>, budget: number | null, now = new Date()): Projection {
  const todayKey = dayKey(now);
  const dates = [...series.keys()].sort();
  const firstDate = dates[0] ?? null;
  const today = series.get(todayKey) ?? 0;
  const yesterday = series.get(dayKey(addDays(now, -1))) ?? 0;
  const monthPrefix = todayKey.slice(0, 7);
  let mtd = 0;
  for (const [k, v] of series) if (k.startsWith(monthPrefix) && k <= todayKey) mtd += v;

  const avg7 = avgDays(series, now, 7, firstDate);
  const avg30 = avgDays(series, now, 30, firstDate);
  const prevAvg7 = avgDays(series, addDays(now, -7), 7, firstDate);

  const dayFrac = (now.getHours() * 60 + now.getMinutes()) / 1440;
  const restToday = Math.max(0, avg7 * (1 - dayFrac));
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const remainingDays = lastDay - now.getDate();
  const projectedMonth = mtd + restToday + avg7 * remainingDays;

  let monthRange: [number, number] | null = null;
  if (remainingDays > 0) {
    const days: number[] = [];
    for (let i = 56; i >= 1; i--) {
      const k = dayKey(addDays(now, -i));
      if (firstDate && k < firstDate) continue;
      days.push(series.get(k) ?? 0);
    }
    const q = windowQuantiles(days, remainingDays);
    if (q) monthRange = [mtd + restToday + q.p10, mtd + restToday + q.p90];
  }

  let budgetHit: Projection["budgetHit"] = null;
  if (budget && budget > 0) {
    if (mtd >= budget) budgetHit = { date: todayKey, already: true };
    else {
      let cum = mtd + restToday;
      if (cum >= budget) budgetHit = { date: todayKey, already: false };
      for (let i = 1; i <= remainingDays && !budgetHit && avg7 > 0; i++) {
        cum += avg7;
        if (cum >= budget) budgetHit = { date: dayKey(addDays(now, i)), already: false };
      }
    }
  }
  return {
    today,
    yesterday,
    mtd,
    avg7,
    prevAvg7,
    avg30,
    projectedMonth,
    monthRange,
    next7: avg7 * 7,
    next30: avg7 * 30,
    next90: avg30 * 90,
    firstDate,
    budget,
    budgetHit,
  };
}

/** Rows for the month view: actual cumulative + projected cumulative per day. */
export function monthCurve(series: Map<string, number>, p: Projection, now = new Date()) {
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const todayKey = dayKey(now);
  const rows: { date: string; day: number; actual: number | null; projected: number | null }[] = [];
  let cum = 0;
  let projCum = 0;
  const dayFrac = (now.getHours() * 60 + now.getMinutes()) / 1440;
  for (let d = 1; d <= lastDay; d++) {
    const k = dayKey(new Date(now.getFullYear(), now.getMonth(), d));
    let projected: number | null = null;
    if (k <= todayKey) cum += series.get(k) ?? 0;
    if (k === todayKey) {
      projected = cum; // projection line starts where the actual line ends
      projCum = cum + p.avg7 * (1 - dayFrac);
    } else if (k > todayKey) {
      projCum += p.avg7;
      projected = projCum;
    }
    rows.push({ date: k, day: d, actual: k <= todayKey ? cum : null, projected });
  }
  return rows;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / DAY);
}

// ---------------------------------------------------------------- 5-hour blocks

export interface Block {
  start: number;
  end: number;
  lastActivity: number;
  requests: number;
  tokens: number;
  cost: number;
  /** A limit-reached record falls inside this block. */
  hitLimit: boolean;
}

/**
 * Splits activity into the 5-hour windows Claude bills against: a window opens at the
 * first request after the previous one closed, and lasts five hours.
 */
export function buildBlocks(fine: FineRow[], limits: LimitSnap[], source: Source, winMs = 5 * HOUR): Block[] {
  const rows = fine.filter((r) => r.source === source && r.requests > 0).sort((a, b) => a.t - b.t);
  const hits = limits.filter((l) => l.source === source && l.windowMinutes === winMs / 60_000 && l.usedPct >= 100).map((l) => l.ts);
  const out: Block[] = [];
  let cur: Block | null = null;
  for (const r of rows) {
    if (!cur || r.t >= cur.end) {
      cur = { start: r.t, end: r.t + winMs, lastActivity: r.t, requests: 0, tokens: 0, cost: 0, hitLimit: false };
      out.push(cur);
    }
    cur.lastActivity = r.t + 600_000;
    cur.requests += r.requests;
    cur.tokens += totalTokens(r);
    cur.cost += r.cost;
  }
  for (const b of out) b.hitLimit = hits.some((t) => t >= b.start && t < b.end);
  return out.reverse();
}
