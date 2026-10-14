import { useCallback, useEffect, useMemo, useState } from "react";
import { api, DEFAULT_SETTINGS, type Dashboard, type Live, type ScanStatus, type Sources, type UiSettings } from "./api";
import { buildLimitViews, dailySeries, project } from "./forecast";
import { fmtAgo, makeMoney } from "./format";
import { evaluateAlerts } from "./notify";
import { Limits } from "./Limits";
import { Overview } from "./Overview";
import { Settings } from "./Settings";
import { Stats } from "./Stats";
import { AppCtx, srcColor, useColors } from "./ui";
import { useUpdater } from "./update";

type Tab = "overview" | "limits" | "stats" | "settings";
const TABS: [Tab, string][] = [
  ["overview", "개요"],
  ["limits", "한도 · 예측"],
  ["stats", "통계"],
  ["settings", "설정"],
];

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<Dashboard | null>(null);
  const [settings, setSettings] = useState<UiSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [sources, setSources] = useState<Sources | null>(null);
  const [error, setError] = useState("");
  const [live, setLive] = useState<Live>({});
  const [, tick] = useState(0);
  const colors = useColors();
  const updater = useUpdater();
  const up = updater.state;

  const load = useCallback(async () => {
    try {
      const [d, src, lv] = await Promise.all([api.dashboard(), api.sources(), api.live()]);
      setData(d);
      setSources(src);
      setLive(lv);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
    api.status().then(setStatus).catch(() => {});
    load();
    const un1 = api.onStatus(setStatus);
    const un2 = api.onData((s) => {
      setStatus(s);
      load();
    });
    // Re-render every 30s so countdowns and "n분 전" stay fresh between scans.
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
      clearInterval(t);
    };
  }, [load]);

  const money = useMemo(() => makeMoney(settings), [settings]);

  // After every refresh: tray icon/tooltip and alerts. Runs while the window is hidden.
  useEffect(() => {
    if (!data) return;
    const views = buildLimitViews(data).filter((v) => !v.idle);
    const month = project(dailySeries(data.daily, "cost", "all"), settings.monthlyBudget);
    const today = month.today;
    const lines = views.map((v) => `${v.title} ${v.windowLabel} ${Math.round(v.nowPct)}%${v.estimated ? "*" : ""}`);
    const tooltip = ["Token View", ...lines, `오늘 ${money(today)}`].join("\n").slice(0, 120); // Windows caps tray tooltips at 127 chars
    api.updateTray(
      tooltip,
      views.slice(0, 3).map((v) => ({ pct: v.nowPct, color: srcColor(colors, v.source) })),
    ).catch(() => {});
    evaluateAlerts(views, month, settings, money).catch(() => {});
  }, [data, settings, money, colors]);
  const running = status?.running;
  const prog = status && status.bytes_total ? status.bytes_done / status.bytes_total : 0;
  const empty = data && data.totals.length === 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/icon.png" alt="" />
          Token View
        </div>
        <nav className="tabs">
          {TABS.map(([k, label]) => (
            <button key={k} className={"tab" + (tab === k ? " active" : "")} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <ServiceBadges live={live} />
        <div className="scanline">
          {running ? (
            <>
              <span>로그 읽는 중 {Math.round(prog * 100)}%</span>
              <div className="progress">
                <div style={{ width: `${prog * 100}%` }} />
              </div>
            </>
          ) : status?.last_scan_ms ? (
            <span title={status.last_error || undefined}>
              {status.last_error ? "⚠ " : ""}갱신 {fmtAgo(status.last_scan_ms)}
            </span>
          ) : null}
          <button className="btn" onClick={() => api.rescan()} disabled={!!running}>
            새로고침
          </button>
        </div>
      </header>
      {(up.kind === "available" || up.kind === "downloading") && (
        <div className="update-bar">
          <span>
            새 버전 <b>v{up.update.version}</b>이 있어요
            {updater.version && <span className="muted"> · 지금 v{updater.version}</span>}
          </span>
          {up.kind === "downloading" ? (
            <span className="muted">
              내려받는 중 {up.total ? Math.round((up.done / up.total) * 100) + "%" : ""} · 설치가 끝나면 다시 시작돼요
            </span>
          ) : (
            <button className="btn primary" onClick={updater.install}>
              업데이트 후 다시 시작
            </button>
          )}
        </div>
      )}
      <main>
        {error && <div className="notice" style={{ maxWidth: 1360, margin: "0 auto 16px" }}>데이터를 불러오지 못했어요: {error}</div>}
        {!data || (empty && running) ? (
          <div className="empty" style={{ paddingTop: 120 }}>
            <div style={{ fontSize: 16, color: "var(--ink)", marginBottom: 8 }}>사용 기록을 처음 읽고 있어요</div>
            로그 크기에 따라 수십 초 걸릴 수 있어요 {running ? `· ${Math.round(prog * 100)}%` : ""}
          </div>
        ) : (
          <AppCtx.Provider value={{ data, settings, money, colors }}>
            {empty && tab !== "settings" ? (
              <div className="empty" style={{ paddingTop: 120 }}>
                아직 기록이 없어요. Claude Code나 Codex를 사용하면 여기에 표시됩니다.
              </div>
            ) : tab === "overview" ? (
              <Overview />
            ) : tab === "limits" ? (
              <Limits claudeHooked={!!sources?.claudeLimitsMtime} />
            ) : tab === "stats" ? (
              <Stats />
            ) : (
              <Settings
                updater={updater}
                sources={sources}
                onSaved={(s) => {
                  setSettings(s);
                  load();
                }}
              />
            )}
          </AppCtx.Provider>
        )}
      </main>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  none: "var(--good)",
  maintenance: "var(--accent)",
  minor: "var(--warning)",
  major: "var(--serious)",
  critical: "var(--critical)",
  unknown: "var(--muted)",
};

/** Claude / OpenAI status page indicators; a label only appears when something is wrong. */
function ServiceBadges({ live }: { live: Live }) {
  const pages = live.status?.pages ?? [];
  if (!pages.length) return null;
  return (
    <div className="badges">
      {pages.map((p) => (
        <span key={p.id} className="badge" title={`${p.name}: ${p.description}`}>
          <span className="dot" style={{ background: STATUS_COLOR[p.indicator] ?? "var(--muted)" }} />
          {p.name}
          {p.indicator !== "none" && p.indicator !== "unknown" && <b>{p.indicator === "maintenance" ? "점검" : "장애"}</b>}
        </span>
      ))}
    </div>
  );
}
