import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState, type ReactNode } from "react";
import { api, type Live, type LiveResult, type UiSettings } from "./api";
import { fmtAgo, fmtInt } from "./format";
import { Card } from "./ui";

type Edit = { s: UiSettings; setS: (s: UiSettings) => void; saveButton: ReactNode };

export function NotifyCard({ s, setS, saveButton }: Edit) {
  const n = s.notify;
  const set = (patch: Partial<UiSettings["notify"]>) => setS({ ...s, notify: { ...n, ...patch } });
  return (
    <Card title="알림" right={saveButton}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
        <label className="check">
          <input type="checkbox" checked={n.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Windows 알림 사용
        </label>
        <div className="field">
          <label>한도 사용률 경고 (%)</label>
          <input
            className="inp"
            value={n.thresholds.join(", ")}
            disabled={!n.enabled}
            onChange={(e) =>
              set({
                thresholds: e.target.value
                  .split(/[,\s]+/)
                  .map(Number)
                  .filter((x) => x > 0 && x <= 100),
              })
            }
          />
          <span className="hint">쉼표로 구분 · 윈도우마다 기준별로 한 번씩 알려요</span>
        </div>
        <label className="check">
          <input type="checkbox" checked={n.exhaust} disabled={!n.enabled} onChange={(e) => set({ exhaust: e.target.checked })} />
          현재 속도면 리셋 전에 소진될 때
        </label>
        <label className="check">
          <input type="checkbox" checked={n.budget} disabled={!n.enabled} onChange={(e) => set({ budget: e.target.checked })} />
          월 예산 초과 예상 · 초과했을 때
        </label>
        <label className="check">
          <input type="checkbox" checked={n.reset} disabled={!n.enabled} onChange={(e) => set({ reset: e.target.checked })} />
          한도가 리셋됐을 때
        </label>
      </div>
    </Card>
  );
}

export function StartupCard() {
  const [on, setOn] = useState<boolean | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (api.inTauri) autostartEnabled().then(setOn).catch((e) => setErr(String(e)));
  }, []);
  const toggle = async (v: boolean) => {
    try {
      await (v ? enableAutostart() : disableAutostart());
      setOn(await autostartEnabled());
    } catch (e) {
      setErr(String(e));
    }
  };
  return (
    <Card title="실행">
      <label className="check" style={{ fontSize: 13 }}>
        <input type="checkbox" checked={!!on} disabled={on === null} onChange={(e) => toggle(e.target.checked)} />
        Windows 시작 시 자동 실행 (트레이에서 조용히 시작)
      </label>
      {err && <div className="notice" style={{ marginTop: 8 }}>{err}</div>}
    </Card>
  );
}

function LiveLine({ label, r, off }: { label: string; r?: LiveResult | null; off: boolean }) {
  let text: ReactNode = "아직 조회 전";
  if (off) text = <span className="muted">꺼짐</span>;
  else if (r?.ok) text = <>✓ {fmtAgo(r.ts)} 조회{r.lastErrorTs && <span className="muted"> · {fmtAgo(r.lastErrorTs)} 실패했었음{r.lastError ? `: ${r.lastError}` : ""}</span>}</>;
  else if (r && !r.ok) text = <><span style={{ color: "var(--critical)" }}>{r.error}</span>{r.lastOk && <span className="muted"> · 마지막 성공 {fmtAgo(r.lastOk)}</span>}</>;
  return (
    <>
      <dt>{label}</dt>
      <dd>{text}</dd>
    </>
  );
}

export function LiveCard({ s, setS, saveButton }: Edit) {
  const [live, setLive] = useState<Live>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api.live().then(setLive).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  const now = async () => {
    setBusy(true);
    setError("");
    try {
      setLive(await api.refreshLive());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const ci = live.codexInfo;
  return (
    <Card
      title="실시간 한도 조회"
      right={
        <div className="row">
          <button className="btn" disabled={busy || !api.inTauri} onClick={now}>
            {busy ? "조회 중…" : "지금 조회"}
          </button>
          {saveButton}
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
        {error && <div className="notice" role="alert">{error}</div>}
        <label className="check">
          <input type="checkbox" checked={s.codexLive} onChange={(e) => setS({ ...s, codexLive: e.target.checked })} />
          Codex: 설치된 Codex CLI에 현재 한도를 직접 물어보기
        </label>
        <label className="check">
          <input type="checkbox" checked={s.claudeApi} onChange={(e) => setS({ ...s, claudeApi: e.target.checked })} />
          Claude: 사용량 API로 실제 5시간·주간 % 받기 (베타)
        </label>
        {s.claudeApi && (
          <div className="notice" style={{ fontSize: 12.5 }}>
            Claude Code의 로그인 토큰(<code>~/.claude/.credentials.json</code>)으로 Anthropic의 비공식 사용량 API를 조회해요. 토큰은 Anthropic에만 보내고 저장하지 않지만, 비공식이라 언제든 바뀌거나 막힐 수 있어요.
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={s.serviceStatus} onChange={(e) => setS({ ...s, serviceStatus: e.target.checked })} />
          Claude · OpenAI 서비스 상태 표시
        </label>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>조회 간격 (초)</label>
          <input className="inp" type="number" min={60} value={s.liveSecs} onChange={(e) => setS({ ...s, liveSecs: Math.max(60, Number(e.target.value) || 300) })} />
        </div>
        <dl className="kv">
          <LiveLine label="Codex" r={live.codex} off={!s.codexLive} />
          <LiveLine label="Claude" r={live.claude} off={!s.claudeApi} />
          {ci && (
            <>
              <dt>Codex 요금제</dt>
              <dd>{ci.planType ?? "-"}</dd>
              <dt>무료 한도 리셋권</dt>
              <dd>{ci.resetCredits != null ? `${fmtInt(ci.resetCredits)}개` : "-"}</dd>
              <dt>크레딧</dt>
              <dd>{ci.credits?.unlimited ? "무제한" : ci.credits?.hasCredits ? ci.credits.balance : "없음"}</dd>
            </>
          )}
        </dl>
      </div>
    </Card>
  );
}

const EXPORTS: { kind: "events" | "daily" | "json"; label: string; name: string; ext: string }[] = [
  { kind: "events", label: "요청 단위 기록 (CSV)", name: "token-view-events.csv", ext: "csv" },
  { kind: "daily", label: "일별 · 모델별 요약 (CSV)", name: "token-view-daily.csv", ext: "csv" },
  { kind: "json", label: "대시보드 데이터 (JSON)", name: "token-view-dashboard.json", ext: "json" },
];

export function ExportCard() {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (e: (typeof EXPORTS)[number]) => {
    setBusy(true);
    try {
      const path = await saveDialog({ defaultPath: e.name, filters: [{ name: e.ext.toUpperCase(), extensions: [e.ext] }] });
      if (!path) return;
      const n = await api.exportData(e.kind, path);
      setMsg(e.kind === "json" ? `저장했어요: ${path}` : `${fmtInt(n)}줄 저장했어요: ${path}`);
    } catch (err) {
      setMsg("저장 실패: " + String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="내보내기">
      <div className="row">
        {EXPORTS.map((e) => (
          <button key={e.kind} className="btn" disabled={!api.inTauri || busy} onClick={() => void run(e)}>
            {e.label}
          </button>
        ))}
      </div>
      {msg && (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 8, wordBreak: "break-all" }}>
          {msg}
        </div>
      )}
    </Card>
  );
}
