import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { api, type UiSettings } from "./api";
import type { LimitView, Projection } from "./forecast";
import { fmtDateTime, fmtDuration, type Money } from "./format";

const STORE = "tv-notified";

/** Keys of alerts already shown, so each event fires once per window / month. */
function load(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORE) || "{}");
  } catch {
    return {};
  }
}

function save(m: Record<string, number>) {
  const cutoff = Date.now() - 40 * 86_400_000;
  for (const k of Object.keys(m)) if (m[k] < cutoff) delete m[k];
  try {
    localStorage.setItem(STORE, JSON.stringify(m));
  } catch {
    /* storage unavailable: worst case an alert repeats */
  }
}

let permitted: boolean | null = null;
async function canNotify() {
  if (!api.inTauri) return false;
  if (permitted === null) {
    permitted = await isPermissionGranted();
    if (!permitted) permitted = (await requestPermission()) === "granted";
  }
  return permitted;
}

export async function evaluateAlerts(views: LimitView[], month: Projection, s: UiSettings, money: Money) {
  if (!s.notify.enabled || !(await canNotify())) return;
  const sent = load();
  const out: { key: string; title: string; body: string }[] = [];
  const now = Date.now();

  for (const v of views) {
    if (v.idle) continue;
    const win = `${v.key}|${Math.round(v.resetsAt / 600_000)}`;
    const name = `${v.title} ${v.windowLabel} 한도`;
    const until = `리셋까지 ${fmtDuration(v.resetsAt - now)}`;
    const top = [...s.notify.thresholds].sort((a, b) => b - a).find((t) => v.nowPct >= t);
    if (top !== undefined) {
      out.push({ key: `${win}|t${top}`, title: `${name} ${Math.round(v.nowPct)}% 사용`, body: `${until}${v.estimated ? " · 추정값" : ""}` });
    }
    // Early in a window a short burst can look alarming; wait for some real usage.
    if (s.notify.exhaust && v.exhaustAt && v.nowPct < 100 && (v.nowPct >= 30 || v.exhaustAt - now < 2 * 3_600_000)) {
      out.push({
        key: `${win}|exhaust`,
        title: `${name} 리셋 전 소진 예상`,
        body: `현재 속도면 ${fmtDateTime(v.exhaustAt)}에 100% · ${until}`,
      });
    }
    if (s.notify.reset && v.isReset && v.history.length) {
      out.push({ key: `${v.key}|reset|${v.history[v.history.length - 1].resetsAt}`, title: `${name} 리셋됨`, body: "다시 100% 사용할 수 있어요" });
    }
  }

  if (s.notify.budget && month.budget) {
    const ym = new Date().toISOString().slice(0, 7);
    if (month.budgetHit?.already) {
      out.push({ key: `budget|${ym}|over`, title: "이번 달 예산 초과", body: `${money(month.mtd)} / 예산 ${money(month.budget)}` });
    } else if (month.budgetHit) {
      out.push({
        key: `budget|${ym}|predict`,
        title: "이번 달 예산 초과 예상",
        body: `현재 속도면 ${month.budgetHit.date.slice(5).replace("-", "/")}에 예산 ${money(month.budget)} 도달`,
      });
    }
  }

  for (const n of out) {
    // A higher threshold implies the lower ones were crossed too; mark them all.
    if (sent[n.key]) continue;
    sent[n.key] = now;
    const m = n.key.match(/^(.*)\|t(\d+)$/);
    if (m) for (const t of s.notify.thresholds) if (t <= Number(m[2])) sent[`${m[1]}|t${t}`] ??= now;
    sendNotification({ title: n.title, body: n.body });
  }
  save(sent);
}
