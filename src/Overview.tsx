import { useMemo, useState } from "react";
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { totalTokens, type Source } from "./api";
import { buildLimitViews, dailySeries, monthCurve, project, type Metric, type Projection } from "./forecast";
import { addDays, dayKey, fmtDate, fmtShortDate, fmtTokens, parseDay } from "./format";
import { LimitCard } from "./LimitCard";
import { Card, Kpi, Seg, SrcDot, TipBox, useApp } from "./ui";

const SOURCES: Source[] = ["claude", "codex"];

export function useProjections(metric: Metric) {
  const { data, settings } = useApp();
  return useMemo(() => {
    const budgetFor = (s: "all" | Source) =>
      metric !== "cost" ? null : s === "all" ? settings.monthlyBudget : s === "claude" ? settings.budgetClaude : settings.budgetCodex;
    const out = {} as Record<"all" | Source, { series: Map<string, number>; p: Projection }>;
    for (const s of ["all", ...SOURCES] as const) {
      const series = dailySeries(data.daily, metric, s);
      out[s] = { series, p: project(series, budgetFor(s)) };
    }
    return out;
  }, [data, settings, metric]);
}

export function Overview() {
  const { data, money } = useApp();
  const limits = useMemo(() => buildLimitViews(data), [data]);
  const cost = useProjections("cost");
  const tok = useProjections("tokens");

  const totalTok = data.totals.reduce((a, r) => a + totalTokens(r), 0);
  const totalCost = data.totals.reduce((a, r) => a + r.cost, 0);
  const requests = data.totals.reduce((a, r) => a + r.requests, 0);
  const first = Math.min(...data.totals.map((r) => r.firstTs));
  const bySrc = (s: Source) => data.totals.find((r) => r.source === s);
  const pc = cost.all.p;
  // Compare today with what an average day had spent by this time of day.
  const now = new Date();
  const dayFrac = Math.max((now.getHours() * 60 + now.getMinutes()) / 1440, 1 / 24);
  const todayVsAvg = pc.avg7 > 0 ? (pc.today / (pc.avg7 * dayFrac) - 1) * 100 : null;

  return (
    <div className="page">
      <div className="grid g4">
        <Kpi
          label="누적 총 토큰"
          value={fmtTokens(totalTok, 2)}
          detail={SOURCES.map((s) => (
            <span key={s}>
              <SrcDot source={s} />
              {fmtTokens(bySrc(s) ? totalTokens(bySrc(s)!) : 0)}
            </span>
          ))}
        />
        <Kpi
          label="API 환산 누적 비용"
          value={money(totalCost)}
          detail={
            <>
              <span>{isFinite(first) ? `${fmtDate(dayKey(new Date(first)))}부터` : "-"}</span>
              <span>요청 {requests.toLocaleString("ko-KR")}회</span>
            </>
          }
        />
        <Kpi
          label="이번 달 (API 환산)"
          value={money(pc.mtd)}
          detail={
            <>
              <span>
                월말 예상 <b style={{ color: "var(--ink)" }}>{money(pc.projectedMonth)}</b>
              </span>
              {pc.budget ? <span>예산 {money(pc.budget)}</span> : null}
            </>
          }
        />
        <Kpi
          label="오늘"
          value={money(pc.today)}
          detail={
            <>
              <span>{fmtTokens(tok.all.p.today)} 토큰</span>
              {todayVsAvg !== null && (
                <span className={todayVsAvg > 0 ? "delta-up" : "delta-down"}>
                  평소 이 시각 대비 {todayVsAvg > 0 ? "+" : ""}
                  {todayVsAvg.toFixed(0)}%
                </span>
              )}
            </>
          }
        />
      </div>

      <div className="section-title">사용 한도</div>
      {limits.length ? (
        <div className={"grid " + (limits.length >= 3 ? "g3" : "g2")}>
          {limits.map((v) => (
            <LimitCard key={v.key} v={v} />
          ))}
        </div>
      ) : (
        <div className="notice info">아직 한도 데이터가 없어요. Codex는 다음 사용 때, Claude는 상태줄이 갱신될 때 수집됩니다.</div>
      )}

      <DailyChart />

      <div className="grid g-main">
        <MonthChart />
        <ProjectionTable />
      </div>
    </div>
  );
}

function DailyChart() {
  const { data, colors, money } = useApp();
  const [metric, setMetric] = useState<Metric>("cost");
  const [range, setRange] = useState<number>(30);
  const proj = useProjections(metric);
  const fmt = (x: number) => (metric === "cost" ? money(x, true) : fmtTokens(x));

  const rows = useMemo(() => {
    const now = new Date();
    const todayKey = dayKey(now);
    const firstKey = proj.all.p.firstDate ?? todayKey;
    let start = range > 0 ? addDays(now, -(range - 1)) : parseDay(firstKey);
    if (dayKey(start) < firstKey) start = parseDay(firstKey);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const out: Record<string, number | string | null>[] = [];
    const dayFrac = (now.getHours() * 60 + now.getMinutes()) / 1440;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const k = dayKey(d);
      const row: Record<string, number | string | null> = { date: k };
      for (const s of SOURCES) {
        const actual = proj[s].series.get(k) ?? 0;
        row[s] = k <= todayKey ? actual : null;
        row[s + "F"] = k > todayKey ? proj[s].p.avg7 : k === todayKey ? proj[s].p.avg7 * (1 - dayFrac) : null;
      }
      out.push(row);
    }
    return out;
  }, [proj, range, data]);

  return (
    <Card
      title="일별 사용량"
      sub="이번 달 남은 기간은 최근 7일 평균으로 예측"
      right={
        <div className="row">
          <Seg value={metric} onChange={setMetric} options={[["cost", "비용"], ["tokens", "토큰"]]} />
          <Seg value={range} onChange={setRange} options={[[14, "14일"], [30, "30일"], [90, "90일"], [0, "전체"]]} />
        </div>
      }
    >
      <div className="legend" style={{ marginBottom: 8 }}>
        <span>
          <span className="sw" style={{ background: colors.claude }} />
          Claude Code
        </span>
        <span>
          <span className="sw" style={{ background: colors.codex }} />
          Codex
        </span>
        <span>
          <span className="sw ghost" style={{ background: colors.ink2 }} />
          예측
        </span>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="18%">
          <CartesianGrid stroke={colors.grid} vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtShortDate} stroke={colors.axis} tick={{ fill: colors.muted, fontSize: 11 }} minTickGap={16} />
          <YAxis tickFormatter={fmt} stroke={colors.axis} tick={{ fill: colors.muted, fontSize: 11 }} width={58} />
          <Tooltip
            cursor={{ fill: colors.grid, opacity: 0.5 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload as Record<string, number | null>;
              const future = r.claude === null;
              const rows: [string, string, string?][] = future
                ? [
                    ["Claude 예측", fmt(r.claudeF ?? 0), colors.claude],
                    ["Codex 예측", fmt(r.codexF ?? 0), colors.codex],
                  ]
                : [
                    ["Claude Code", fmt(r.claude ?? 0), colors.claude],
                    ["Codex", fmt(r.codex ?? 0), colors.codex],
                    ["합계", fmt((r.claude ?? 0) + (r.codex ?? 0))],
                  ];
              if (!future && r.claudeF != null) rows.push(["오늘 남은 예측", fmt((r.claudeF ?? 0) + (r.codexF ?? 0))]);
              return <TipBox title={fmtDate(String(label)) + (future ? " · 예측" : "")} rows={rows} />;
            }}
          />
          <Bar dataKey="claude" stackId="a" fill={colors.claude} stroke={colors.surface} strokeWidth={1} isAnimationActive={false} />
          <Bar dataKey="codex" stackId="a" fill={colors.codex} stroke={colors.surface} strokeWidth={1} isAnimationActive={false} />
          <Bar dataKey="claudeF" stackId="a" fill={colors.claude} fillOpacity={0.3} isAnimationActive={false} />
          <Bar dataKey="codexF" stackId="a" fill={colors.codex} fillOpacity={0.3} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}

function MonthChart() {
  const { colors, money } = useApp();
  const [metric, setMetric] = useState<Metric>("cost");
  const proj = useProjections(metric);
  const fmt = (x: number) => (metric === "cost" ? money(x, true) : fmtTokens(x));
  const rows = useMemo(() => monthCurve(proj.all.series, proj.all.p), [proj]);
  const budget = proj.all.p.budget;
  const now = new Date();
  return (
    <Card
      title={`${now.getMonth() + 1}월 누적`}
      sub={`월말 예상 ${fmt(proj.all.p.projectedMonth)}`}
      right={<Seg value={metric} onChange={setMetric} options={[["cost", "비용"], ["tokens", "토큰"]]} />}
    >
      <div className="legend" style={{ marginBottom: 8 }}>
        <span>
          <span className="sw" style={{ background: colors.ink2 }} />
          실제 누적
        </span>
        <span>
          <span className="sw dash" />
          예측 (최근 7일 평균 속도)
        </span>
        {budget ? (
          <span>
            <span className="sw" style={{ background: colors.critical, height: 2, verticalAlign: 3 }} />
            월 예산
          </span>
        ) : null}
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={colors.grid} vertical={false} />
          <XAxis dataKey="day" stroke={colors.axis} tick={{ fill: colors.muted, fontSize: 11 }} tickFormatter={(d) => `${d}일`} minTickGap={12} />
          <YAxis tickFormatter={fmt} stroke={colors.axis} tick={{ fill: colors.muted, fontSize: 11 }} width={58} domain={[0, (max: number) => Math.max(max, budget ?? 0) * 1.05]} />
          <Tooltip
            cursor={{ stroke: colors.axis }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload as { date: string; actual: number | null; projected: number | null };
              const rows: [string, string][] = [];
              if (r.actual !== null) rows.push(["실제 누적", fmt(r.actual)]);
              if (r.projected !== null && r.actual === null) rows.push(["예측 누적", fmt(r.projected)]);
              if (budget) rows.push(["예산", fmt(budget)]);
              return <TipBox title={fmtDate(r.date)} rows={rows} />;
            }}
          />
          {budget ? <ReferenceLine y={budget} stroke={colors.critical} strokeWidth={1} /> : null}
          <Area dataKey="actual" stroke={colors.ink2} strokeWidth={2} fill={colors.ink2} fillOpacity={0.08} isAnimationActive={false} connectNulls={false} />
          <Line dataKey="projected" stroke={colors.ink2} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      {proj.all.p.budgetHit && (
        <div className="status" style={{ marginTop: 8 }}>
          <span className="ico" style={{ background: colors.critical, color: "#fff" }}>!</span>
          <div>
            {proj.all.p.budgetHit.already ? "이번 달 예산을 이미 넘었어요" : <>현재 속도면 <b>{fmtDate(proj.all.p.budgetHit.date)}</b>에 월 예산 도달 예상</>}
          </div>
        </div>
      )}
    </Card>
  );
}

function ProjectionTable() {
  const { money } = useApp();
  const [metric, setMetric] = useState<Metric>("cost");
  const proj = useProjections(metric);
  const fmt = (x: number) => (metric === "cost" ? money(x) : fmtTokens(x));
  const cols = ["all", "claude", "codex"] as const;
  const rows: [string, (p: Projection) => number][] = [
    ["오늘 (지금까지)", (p) => p.today],
    ["어제", (p) => p.yesterday],
    ["최근 7일 일평균", (p) => p.avg7],
    ["최근 30일 일평균", (p) => p.avg30],
    ["이번 달 누적", (p) => p.mtd],
    ["월말 예상", (p) => p.projectedMonth],
    ["앞으로 7일", (p) => p.next7],
    ["앞으로 30일", (p) => p.next30],
    ["앞으로 90일", (p) => p.next90],
  ];
  const trend = proj.all.p.prevAvg7 > 0 ? (proj.all.p.avg7 / proj.all.p.prevAvg7 - 1) * 100 : null;
  return (
    <Card title="예측 요약" right={<Seg value={metric} onChange={setMetric} options={[["cost", "비용"], ["tokens", "토큰"]]} />}>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>전체</th>
              <th>
                <SrcDot source="claude" />
                Claude
              </th>
              <th>
                <SrcDot source="codex" />
                Codex
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, f], i) => (
              <tr key={label} style={i === 5 ? { fontWeight: 650 } : undefined}>
                <td>{label}</td>
                {cols.map((c) => (
                  <td key={c}>{fmt(f(proj[c].p))}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {trend !== null && (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
          최근 7일 평균은 그 전 7일보다{" "}
          <b className={trend > 0 ? "delta-up" : "delta-down"}>
            {trend > 0 ? "+" : ""}
            {trend.toFixed(0)}%
          </b>{" "}
          {trend > 0 ? "늘었어요" : "줄었어요"}. 예측은 최근 7일 평균(90일은 30일 평균) 속도가 유지된다고 가정합니다.
        </div>
      )}
    </Card>
  );
}
