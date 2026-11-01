import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, FAILURE_TEXT, type Dashboard, type Live, type Source } from "./api";
import { buildLimitViews, type LimitView } from "./forecast";

const NAMES: Record<Source, string> = { claude: "Claude", codex: "Codex" };

/** "3d 5h" / "2h 10m" / "35m": the HUD has no room for the long Korean form. */
function shortLeft(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

/** Same precision as the limit cards; a "~" prefix read as a minus sign at this size. */
const pctText = (v: LimitView) => `${v.nowPct.toFixed(v.nowPct < 10 ? 1 : 0)}%`;

function SourceIcon({ source }: { source: Source }) {
  return source === "claude" ? (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" stroke="var(--claude)" strokeWidth="2" strokeLinecap="round">
      <path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="var(--codex)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2" width="13" height="12" rx="3" />
      <path d="M4.8 6.2 7 8l-2.2 1.8M8.6 10.2h2.6" />
    </svg>
  );
}

function Segment({ v, now }: { v: LimitView; now: number }) {
  const left = v.resetsAt > now ? shortLeft(v.resetsAt - now) : null;
  return (
    <span className="hud-seg">
      <span className="hud-win">{v.windowLabel}</span>
      {v.idle ? <span className="hud-reset">대기</span> : <>
        <b className={`hud-pct ${v.status}${v.estimated ? " est" : ""}`}>{pctText(v)}</b>
        {left && <span className="hud-reset">↻ {left}</span>}
      </>}
    </span>
  );
}

/** Always-on-top overlay window: one pill per provider with its running limits. */
export function Hud() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [live, setLive] = useState<Live>({});
  const [, tick] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => Promise.all([api.dashboard(), api.live()]).then(([d, l]) => { setData(d); setLive(l); }).catch(() => {});
    void load();
    const un = api.onData(() => void load()).catch(() => () => {});
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => {
      un.then((f) => f()).catch(() => {});
      clearInterval(t);
    };
  }, []);

  // The window has no frame, so it is exactly as big as the pills.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      void getCurrentWindow().setSize(new LogicalSize(Math.ceil(r.width), Math.ceil(r.height))).catch(() => {});
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const now = Date.now();
  const views = data ? buildLimitViews(data, now) : [];
  const pills = (["claude", "codex"] as const).flatMap((source) => {
    const mine = views.filter((v) => v.source === source);
    const r = live[source];
    const failure = r?.ok === false ? (r.reason ? FAILURE_TEXT[r.reason] : "조회 실패") : "";
    if (!mine.length && !failure) return [];
    const title = [
      ...mine.map((v) => `${NAMES[source]} ${v.windowLabel} ${pctText(v)}${v.estimated ? " (추정)" : ""}${v.resetsAt > now ? ` · ${shortLeft(v.resetsAt - now)} 후 리셋` : ""}`),
      failure && `${NAMES[source]} 한도 조회 실패: ${failure}`,
    ].filter(Boolean).join("\n");
    return [(
      <div key={source} className={`hud-pill ${source}${mine.length ? "" : " error"}`} title={title}>
        <SourceIcon source={source} />
        {mine.length ? mine.map((v, i) => <span key={v.key} className="hud-group">{i > 0 && <span className="hud-sep" />}<Segment v={v} now={now} /></span>)
          : <span className="hud-error-text">{failure}</span>}
        {mine.length > 0 && failure && <span className="hud-warn" aria-label={failure}>!</span>}
      </div>
    )];
  });

  return (
    <div
      ref={root}
      className="hud"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        if (e.detail >= 2) void invoke("open_main");
        else void getCurrentWindow().startDragging().catch(() => {});
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        void invoke("hud_menu");
      }}
    >
      {pills.length ? pills : <div className="hud-pill empty">{data ? "한도 기록 없음" : "불러오는 중…"}</div>}
    </div>
  );
}
