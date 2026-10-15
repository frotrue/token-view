import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, DEFAULT_SETTINGS, type Dashboard, type Live, type ScanStatus, type Sources, type UiSettings } from "./api";
import { cloud, getSnapshot, useCloud } from "./cloud";
import { BrowserSupportCard, CloudPanel } from "./CloudPanel";
import { buildLimitViews, dailySeries, project } from "./forecast";
import { fmtAgo, fmtDateTime, makeMoney } from "./format";
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
const EMPTY_DASHBOARD: Dashboard = { now: 0, totals: [], daily: [], dailyModel: [], dailyProject: [], hourly: [], fine: [], limits: [], unpriced: [], sessions: [] };

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<Dashboard | null>(null);
  const [settings, setSettings] = useState<UiSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [sources, setSources] = useState<Sources | null>(null);
  const [error, setError] = useState("");
  const [live, setLive] = useState<Live>({});
  const [loadedIdentity, setLoadedIdentity] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [, tick] = useState(0);
  const cloudState = useCloud();
  const browser = !api.inTauri;
  const identity = browser ? `${cloudState.mode}:${cloudState.email ?? ""}:${cloudState.selectedDeviceId ?? ""}` : "desktop";
  const currentIdentity = useRef(identity);
  const canLoad = useRef(!browser || cloudState.hasData);
  const loadVersion = useRef(0);
  currentIdentity.current = identity;
  canLoad.current = !browser || cloudState.hasData;
  const colors = useColors();
  const updater = useUpdater();
  const up = updater.state;

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const sourceIdentity = currentIdentity.current;
    if (!canLoad.current) {
      setData(null);
      setLive({});
      setSources(null);
      setError("");
      try {
        const nextSettings = await api.settings();
        if (version === loadVersion.current && sourceIdentity === currentIdentity.current) setSettings(nextSettings);
      } catch { /* Local preferences may be unavailable before initialization. */ }
      return;
    }
    try {
      const [d, src, lv, nextSettings] = await Promise.all([api.dashboard(), api.sources(), api.live(), api.settings()]);
      if (version !== loadVersion.current || sourceIdentity !== currentIdentity.current || !canLoad.current) return;
      setData(d);
      setSources(src);
      setLive(lv);
      setSettings(nextSettings);
      setLoadedIdentity(sourceIdentity);
      setError("");
    } catch (e) {
      if (version === loadVersion.current && sourceIdentity === currentIdentity.current && canLoad.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
    api.status().then(setStatus).catch(() => {});
    const un1 = api.onStatus(setStatus).catch(() => () => {});
    const un2 = api.onData((s) => {
      setStatus(s);
      void load();
    }).catch(() => () => {});
    // Re-render every 30s so countdowns and "n분 전" stay fresh between scans.
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => {
      un1.then((f) => f()).catch(() => {});
      un2.then((f) => f()).catch(() => {});
      clearInterval(t);
    };
  }, [load]);

  useEffect(() => {
    if (browser && !cloudState.initialized) return;
    void load();
  }, [browser, cloudState.initialized, cloudState.hasData, cloudState.capturedAt, identity, load]);

  const visibleData = !browser || (cloudState.hasData && loadedIdentity === identity) ? data : null;
  const refresh = async () => {
    setRefreshing(true);
    setError("");
    try { await api.rescan(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setRefreshing(false); }
  };

  const money = useMemo(() => makeMoney(settings), [settings]);

  // After every refresh: tray icon/tooltip and alerts. Runs while the window is hidden.
  useEffect(() => {
    if (!data || browser) return;
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
  }, [data, settings, money, colors, browser]);
  const running = status?.running;
  const prog = status && status.bytes_total ? status.bytes_done / status.bytes_total : 0;
  const empty = visibleData && visibleData.totals.length === 0;
  const ready = browser ? cloudState.hasData : !!visibleData;
  const snapshotAt = browser && visibleData ? cloudState.capturedAt ?? visibleData.now : undefined;
  const snapshotTimeZone = browser && visibleData ? getSnapshot()?.timezone : undefined;

  return (
    <div className={`app${browser ? " browser-app" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <img src="/icon.png" alt="" />
          Token View
          {browser && <span className="beta-label">BETA</span>}
        </div>
        <nav className="tabs">
          {TABS.map(([k, label]) => (
            <button key={k} className={"tab" + (tab === k ? " active" : "")} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {!browser && <ServiceBadges live={live} />}
        <div className="scanline">
          {browser ? (
            <span className={`source-pill ${cloudState.mode === "demo" ? "demo" : ""}`}>
              {cloudState.mode === "demo" ? "샘플 데이터" : cloudState.mode === "import" ? "가져온 파일" : cloudState.offline ? "오프라인" : "PC 스냅샷"}
            </span>
          ) : running ? (
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
          <button className="btn" onClick={() => void refresh()} disabled={refreshing || !!running || (browser && (!cloudState.authenticated || cloudState.offline || cloudState.busy))}>
            {refreshing ? "갱신 중…" : browser ? "가져오기" : "새로고침"}
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
        {error && <div className="notice app-notice" role="alert">데이터를 불러오지 못했어요: {error}</div>}
        {browser && ready && <SnapshotBanner live={visibleData ? live : {}} snapshotTimeZone={snapshotTimeZone} onSettings={() => setTab("settings")} />}
        {browser && !ready && tab !== "settings" ? (
          <div className="page onboarding-page">
            <section className="onboarding-hero">
              <div className="eyebrow">CLAUDE CODE · CODEX</div>
              <h1>PC의 AI 사용량을<br />손안에서 확인하세요.</h1>
              <p>쓴 토큰, 남은 한도, 월말 예상 비용까지.<br />PC에서 수집하고 휴대폰에서 이어 봐요.</p>
              <div className="onboarding-features"><span><span className="dot" style={{ background: "var(--claude)" }} />Claude Code</span><span><span className="dot" style={{ background: "var(--codex)" }} />Codex</span><span>비공개 기록</span></div>
            </section>
            <CloudPanel onboarding />
            <BrowserSupportCard />
          </div>
        ) : tab === "settings" ? (
          <AppCtx.Provider value={{ data: visibleData ?? EMPTY_DASHBOARD, settings, money, colors, snapshotAt, snapshotTimeZone }}>
            <Settings key={`${identity}:${ready ? "data" : "empty"}`} updater={updater} sources={sources} onSaved={(s) => { setSettings(s); void load(); }} />
          </AppCtx.Provider>
        ) : !visibleData || (empty && running && !browser) ? (
          <div className="empty" style={{ paddingTop: 120 }}>
            <div style={{ fontSize: 16, color: "var(--ink)", marginBottom: 8 }}>{browser ? "저장된 기록을 불러오고 있어요" : error ? "기록을 불러올 수 없어요" : "사용 기록을 처음 읽고 있어요"}</div>
            {browser ? "잠시만 기다려 주세요." : error ? "새로고침하거나 설정에서 데이터 소스를 확인해 주세요." : <>로그 크기에 따라 수십 초 걸릴 수 있어요 {running ? `· ${Math.round(prog * 100)}%` : ""}</>}
          </div>
        ) : (
          <AppCtx.Provider value={{ data: visibleData, settings, money, colors, snapshotAt, snapshotTimeZone }}>
            {empty ? (
              <div className="empty" style={{ paddingTop: 120 }}>
                {browser ? "이 PC의 스냅샷에 아직 사용 기록이 없어요. PC에서 Claude Code나 Codex를 사용한 뒤 동기화해 주세요." : "아직 기록이 없어요. Claude Code나 Codex를 사용하면 여기에 표시됩니다."}
              </div>
            ) : tab === "overview" ? (
              <Overview />
            ) : tab === "limits" ? (
              <Limits claudeHooked={!!sources?.claudeLimitsMtime} />
            ) : tab === "stats" ? (
              <Stats />
            ) : null}
          </AppCtx.Provider>
        )}
      </main>
      <nav className="mobile-tabs" aria-label="주 메뉴">
        {TABS.map(([key, label]) => <button key={key} className={tab === key ? "active" : ""}
          aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)}>
          <TabIcon tab={key} /><span>{label}</span>
        </button>)}
      </nav>
    </div>
  );
}

function SnapshotBanner({ live, snapshotTimeZone, onSettings }: { live: Live; snapshotTimeZone?: string; onSettings: () => void }) {
  const state = useCloud();
  const [error, setError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const selected = state.devices.find((device) => device.id === state.selectedDeviceId);
  const stale = !!state.capturedAt && Date.now() - state.capturedAt > 10 * 60_000;
  const failedProviders = [live.claude?.ok === false ? "Claude" : "", live.codex?.ok === false ? "Codex" : ""].filter(Boolean);
  const request = async () => {
    setRequesting(true); setError("");
    try { await cloud.requestRefresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setRequesting(false); }
  };
  return <section className={`snapshot-banner ${state.mode === "demo" ? "demo-banner" : ""}`} aria-label="데이터 기준 시각">
    <div className="snapshot-heading">
      <strong>{state.mode === "demo" ? "샘플 데이터 · 실제 사용량이 아니에요" : state.mode === "import" ? "가져온 JSON 스냅샷" : selected?.name ?? "PC 스냅샷"}</strong>
      <button className="text-button" onClick={onSettings}>{state.mode === "cloud" ? "기기 변경" : "연결 설정"}</button>
    </div>
    <div className="snapshot-times">
      <span>PC 캡처 <b>{state.capturedAt ? fmtDateTime(state.capturedAt) : "시각 없음"}</b>{state.capturedAt ? ` · ${fmtAgo(state.capturedAt)}` : ""}</span>
      <span>이 기기에서 가져옴 <b>{state.lastFetchedAt ? fmtAgo(state.lastFetchedAt) : "기록 없음"}</b></span>
    </div>
    {snapshotTimeZone && snapshotTimeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone && <div className="hint">일별 집계 기준: {snapshotTimeZone} · PC 시간대</div>}
    <div className="snapshot-footer">
      <span>{state.offline ? "오프라인 · 저장된 기록을 보고 있어요. " : ""}{stale ? "오래된 캡처예요. " : ""}한도와 예측은 캡처 시점을 기준으로 계산해요.</span>
      {state.mode === "cloud" && state.needsReconnect && <button className="btn primary" disabled={state.busy || state.offline}
        onClick={() => void cloud.signIn().catch(() => {})}>구글 다시 연결</button>}
      {state.mode === "cloud" && state.authenticated && <button className="btn" disabled={requesting || state.busy || state.offline || !state.selectedDeviceId}
        onClick={() => void request()}>{requesting ? "요청 중…" : "PC에 최신 한도 요청"}</button>}
    </div>
    {state.refreshRequestedAt && state.mode === "cloud" && <div className="hint" role="status">PC 요청 {fmtAgo(state.refreshRequestedAt)} · PC가 실행 중이고 온라인이면 수집 후 반영돼요. 요청은 10분 후 만료돼요.</div>}
    {failedProviders.length > 0 && <div className="notice">{failedProviders.join(" · ")} 한도 조회 실패 · 마지막 확인값 표시</div>}
    {(error || state.error) && <div className="notice" role="alert">{error || state.error}</div>}
    {state.warning && <div className="notice">{state.warning}</div>}
  </section>;
}

function TabIcon({ tab }: { tab: Tab }) {
  const path = tab === "overview" ? "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"
    : tab === "limits" ? "M3 12a9 9 0 0 1 18 0M5 12h2M17 12h2M12 3v2M8 19h8M12 15l5-7"
    : tab === "stats" ? "M4 20V10M12 20V4M20 20V8"
    : "M4 7h16M4 17h16M9 4v6M15 14v6";
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
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
