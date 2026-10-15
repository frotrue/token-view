import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api, type PriceEntry, type Pricing, type PricingInfo, type Sources, type StatuslineStatus, type UiSettings } from "./api";
import { fmtAgo, fmtTokens } from "./format";
import { ExportCard, LiveCard, NotifyCard, StartupCard } from "./SettingsExtra";
import { BrowserSupportCard, CloudPanel } from "./CloudPanel";
import { isNativeMobile, useCloud } from "./cloud";
import { Card, Seg, useApp } from "./ui";
import { updatesEnabled, type useUpdater } from "./update";

type Updater = ReturnType<typeof useUpdater>;

export function Settings({ onSaved, sources, updater }: { onSaved: (s: UiSettings) => void; sources: Sources | null; updater: Updater }) {
  const { settings, data, snapshotTimeZone } = useApp();
  const cloudState = useCloud();
  const id = useId();
  const [s, setS] = useState<UiSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const persisted = useRef(JSON.stringify(settings));
  useEffect(() => {
    const previous = persisted.current;
    setS((current) => JSON.stringify(current) === previous ? settings : current);
    persisted.current = JSON.stringify(settings);
  }, [settings]);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const save = async () => {
    setSaving(true); setSaveError(""); setSaved(false);
    try { await api.setSettings(s); onSaved(s); setSaved(true); }
    catch (err) { setSaveError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  const saveButton = (
    <button className="btn primary" disabled={!dirty || saving || (!api.inTauri && !cloudState.hasData)} onClick={() => void save()}>
      {saving ? "저장 중…" : "저장"}
    </button>
  );

  return (
    <div className="page">
      <CloudPanel />
      {saveError && <div className="notice" role="alert">설정을 저장하지 못했어요: {saveError}</div>}
      {saved && !dirty && <div className="notice info" role="status">설정을 저장했어요.</div>}
      <div className="grid g2">
        <Card title="표시 · 예산" right={saveButton}>
          <div className="grid g2" style={{ gap: 14 }}>
            <div className="field">
              <label>통화</label>
              <Seg value={s.currency} onChange={(currency) => setS({ ...s, currency })} options={[["USD", "달러 ($)"], ["KRW", "원화 (₩)"]]} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-rate`}>환율 (₩/$)</label>
              <input id={`${id}-rate`} className="inp" type="number" inputMode="decimal" min={1} value={s.krwRate} onChange={(e) => setS({ ...s, krwRate: Number(e.target.value) || 0 })} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-budget`}>월 예산 · 전체 (USD)</label>
              <input id={`${id}-budget`} className="inp" type="number" inputMode="decimal" min={0} placeholder="없음" value={s.monthlyBudget ?? ""} onChange={(e) => setS({ ...s, monthlyBudget: num(e.target.value) })} />
              <span className="hint">API 환산 비용 기준. 누적 차트와 도달일 예측에 쓰여요.</span>
            </div>
            <div className="field">
              <label>월 예산 · Claude / Codex (USD)</label>
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <input className="inp" type="number" inputMode="decimal" min={0} aria-label="Claude 월 예산 USD" placeholder="Claude" value={s.budgetClaude ?? ""} onChange={(e) => setS({ ...s, budgetClaude: num(e.target.value) })} />
                <input className="inp" type="number" inputMode="decimal" min={0} aria-label="Codex 월 예산 USD" placeholder="Codex" value={s.budgetCodex ?? ""} onChange={(e) => setS({ ...s, budgetCodex: num(e.target.value) })} />
              </div>
            </div>
            {api.inTauri && <div className="field">
              <label>자동 새로고침 간격 (초)</label>
              <input className="inp" type="number" min={10} value={s.refreshSecs} onChange={(e) => setS({ ...s, refreshSecs: Math.max(10, Number(e.target.value) || 60) })} />
            </div>}
            {api.inTauri && <div className="field">
              <label>창 닫기</label>
              <label className="check">
                <input type="checkbox" checked={s.closeToTray} onChange={(e) => setS({ ...s, closeToTray: e.target.checked })} />
                닫으면 트레이로 숨기고 계속 수집
              </label>
            </div>}
          </div>
          {!api.inTauri && <p className="hint" style={{ marginBottom: 0 }}>{!cloudState.hasData ? "기록을 먼저 연결하거나 JSON·샘플을 가져오면 표시·예산 설정을 저장할 수 있어요." : cloudState.mode === "cloud" ? "표시·예산 설정은 같은 계정의 PC와 동기화돼요. 저장하려면 인터넷 연결이 필요해요." : "가져온 JSON·샘플의 표시·예산 설정은 현재 기기에 저장돼요."}</p>}
          {snapshotTimeZone && snapshotTimeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone && <p className="hint" style={{ marginBottom: 0 }}>일별 집계 기준: {snapshotTimeZone} · PC 시간대</p>}
        </Card>
        {api.inTauri ? <SourcesCard sources={sources} /> : isNativeMobile ? <AppInfoCard updater={updater} /> : <BrowserSupportCard />}
      </div>
      {api.inTauri && <><div className="grid g2">
        <NotifyCard s={s} setS={setS} saveButton={saveButton} />
        <LiveCard s={s} setS={setS} saveButton={saveButton} />
      </div>
      <div className="grid g2">
        <ClaudeLinkCard sources={sources} />
        <AppInfoCard updater={updater} />
      </div>
      <div className="grid g2">
        <StartupCard />
        <ExportCard />
      </div>
      </>}
      {(api.inTauri || cloudState.hasData) && <PricingCard key={api.inTauri ? "desktop-pricing" : `${cloudState.mode}:${cloudState.selectedDeviceId}:${cloudState.capturedAt}`}
        unpriced={data.unpriced.map((u) => ({ model: u.model, tokens: u.tokens }))} />}
    </div>
  );
}

function SourcesCard({ sources }: { sources: Sources | null }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const rebuild = async () => {
    setBusy(true); setError("");
    try { await api.rebuild(); setConfirm(false); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  if (!sources) return <Card title="데이터 소스">불러오는 중…</Card>;
  const hooked = sources.claudeLimitsMtime !== null;
  return (
    <Card title="데이터 소스">
      <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
        {[
          ["Claude Code 로그", sources.claude],
          ["Codex 로그", sources.codex],
        ].map(([label, list]) => (
          <div key={label as string}>
            <div className="muted">{label as string}</div>
            {(list as Sources["claude"]).map((p) => (
              <div key={p.path}>
                {p.exists ? "✓" : "–"} <code>{p.path}</code>
              </div>
            ))}
          </div>
        ))}
        <div>
          <div className="muted">Claude 한도 스냅샷</div>
          <div>
            {hooked ? "✓" : "–"} <code>{sources.claudeLimitsFile}</code>
            {hooked && <span className="muted"> · 마지막 기록 {fmtAgo(sources.claudeLimitsMtime!)}</span>}
          </div>
        </div>
        <div className="row" style={{ marginTop: 4 }}>
          {confirm ? (
            <>
              <span>저장된 기록을 지우고 로그에서 다시 읽을까요? 이미 삭제된 로그 파일의 기록은 사라져요.</span>
              <button className="btn danger" disabled={busy} onClick={() => void rebuild()}>{busy ? "다시 읽는 중…" : "다시 읽기"}</button>
              <button className="btn" onClick={() => setConfirm(false)}>취소</button>
            </>
          ) : (
            <button className="btn" onClick={() => setConfirm(true)}>데이터베이스 다시 만들기</button>
          )}
        </div>
        {error && <div className="notice" role="alert">{error}</div>}
      </div>
    </Card>
  );
}

function ClaudeLinkCard({ sources }: { sources: Sources | null }) {
  const [st, setSt] = useState<StatuslineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.statusline().then(setSt).catch((e) => setErr(String(e)));
  }, []);
  const toggle = async (connect: boolean) => {
    setBusy(true);
    setErr("");
    try {
      setSt(await api.statuslineConnect(connect));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  const recent = sources?.claudeLimitsMtime ? Date.now() - sources.claudeLimitsMtime < 7 * 86_400_000 : false;
  return (
    <Card
      title="Claude 한도 수집"
      right={
        st && (
          <button className={"btn" + (st.connected ? "" : " primary")} disabled={busy} onClick={() => toggle(!st.connected)}>
            {st.connected ? "연결 해제" : "자동 연결"}
          </button>
        )
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
        <div className="muted">
          Claude의 5시간·주간 한도 %는 Claude Code 상태줄에만 전달돼요. 자동 연결하면 Token View가 상태줄 명령으로 등록되어 한도를 기록하고, 기존 상태줄 내용은 그대로 이어서 보여 줘요.
        </div>
        {st ? (
          <dl className="kv">
            <dt>상태</dt>
            <dd>{st.connected ? "✓ 연결됨" : recent ? "다른 방식으로 수집 중" : "연결 안 됨"}</dd>
            <dt>기존 상태줄</dt>
            <dd>
              <code>{(st.connected ? st.original?.command : st.command) || "없음 (기본 표시 사용)"}</code>
            </dd>
            <dt>설정 파일</dt>
            <dd>
              <code>{st.settingsPath}</code>
            </dd>
            {sources?.claudeLimitsMtime ? (
              <>
                <dt>마지막 기록</dt>
                <dd>{fmtAgo(sources.claudeLimitsMtime)}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          !err && <div className="muted">앱에서만 사용할 수 있어요</div>
        )}
        {err && <div className="notice">{err}</div>}
        <div className="muted" style={{ fontSize: 12 }}>
          설정 파일은 처음 바꿀 때 <code>settings.json.bak-tokenview</code>로 백업돼요. 연결 해제하면 원래 상태줄로 돌아가요.
        </div>
      </div>
    </Card>
  );
}

function AppInfoCard({ updater }: { updater: Updater }) {
  const st = updater.state;
  let line: ReactNode = null;
  if (st.kind === "checking") line = "확인 중…";
  else if (st.kind === "none") line = "최신 버전이에요";
  else if (st.kind === "available") line = <>새 버전 <b>v{st.update.version}</b>이 있어요</>;
  else if (st.kind === "downloading") line = "내려받는 중…";
  else if (st.kind === "installing") line = "설치 화면에서 ‘업데이트’를 눌러 주세요";
  else if (st.kind === "error") line = <span style={{ color: "var(--critical)" }}>확인 실패: {st.message}</span>;
  return (
    <Card
      title="앱 정보 · 업데이트"
      right={
        st.kind === "available" ? (
          <button className="btn primary" onClick={updater.install}>
            {isNativeMobile ? "내려받아 설치" : "업데이트 후 다시 시작"}
          </button>
        ) : (
          <button className="btn" disabled={st.kind === "checking" || st.kind === "downloading" || st.kind === "installing" || !updatesEnabled} onClick={updater.check}>
            업데이트 확인
          </button>
        )
      }
    >
      <dl className="kv">
        <dt>현재 버전</dt>
        <dd>{updater.version ? `v${updater.version}` : "-"}</dd>
        <dt>업데이트</dt>
        <dd>{line ?? "실행할 때와 6시간마다 자동으로 확인해요"}</dd>
        <dt>배포</dt>
        <dd>
          <code>github.com/frotrue/token-view</code>
        </dd>
      </dl>
    </Card>
  );
}

const PRICE_FIELDS: [keyof PriceEntry, string][] = [
  ["input", "입력"],
  ["cache_write_5m", "캐시 쓰기"],
  ["cache_write_1h", "캐시 쓰기 1h"],
  ["cache_read", "캐시 읽기"],
  ["output", "출력"],
];

function PricingCard({ unpriced }: { unpriced: { model: string; tokens: number }[] }) {
  const [p, setP] = useState<Pricing | null>(null);
  const [info, setInfo] = useState<PricingInfo | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const apply = (x: PricingInfo) => {
    setInfo(x);
    setP(x.pricing);
    setSaved(JSON.stringify(x.pricing));
  };
  useEffect(() => {
    api.pricing().then(apply).catch((err) => setMsg(err instanceof Error ? err.message : String(err)));
  }, []);
  if (!p) return <Card title="모델 단가">{msg ? <div className="notice" role="alert">{msg}</div> : "불러오는 중…"}</Card>;
  if (!api.inTauri) return <Card title="캡처에 사용된 모델 단가" sub="USD / 100만 토큰 · 읽기 전용">
    <p className="hint">PC에서 캡처한 단가표예요. 단가 변경과 비용 다시 계산은 PC 앱에서 할 수 있어요.</p>
    <div className="tbl-wrap" tabIndex={0} aria-label="모델 단가표, 가로로 스크롤할 수 있어요">
      <table><thead><tr><th>모델</th>{PRICE_FIELDS.map(([, label]) => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{p.entries.map((entry, index) => <tr key={`${entry.model}-${index}`}><td className="name-cell">{entry.model}</td>
          {PRICE_FIELDS.map(([field]) => <td key={field}>${Number(entry[field]).toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </Card>;
  const dirty = JSON.stringify(p) !== saved;
  const upd = (i: number, k: keyof PriceEntry, v: string) => {
    const entries = [...p.entries];
    entries[i] = { ...entries[i], [k]: k === "model" ? v : Number(v) || 0 };
    setP({ ...p, entries });
  };
  const save = async (next: Pricing | null) => {
    setBusy(true);
    try {
      apply(await api.setPricing(next));
      await api.rescan();
    } catch (err) {
      setMsg("저장 실패: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.refreshPricing();
      apply(r);
      setMsg(r.custom ? `기본 단가표 ${r.defaultVersion}를 받았어요 · 직접 수정한 단가를 계속 사용 중이에요` : `기본 단가표 ${r.defaultVersion} 적용됨`);
    } catch (e) {
      setMsg("받기 실패: " + String(e));
    } finally {
      setBusy(false);
    }
  };
  const addModel = (model = "") =>
    setP({
      ...p,
      entries: [
        ...p.entries,
        { model, input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, long_ctx_threshold: 0, long_input_mult: 1, long_output_mult: 1 },
      ],
    });
  const missing = unpriced.filter((u) => !p.entries.some((e) => e.model === u.model));
  return (
    <Card
      title="모델 단가"
      sub={
        info
          ? `USD / 100만 토큰 · ${info.custom ? "직접 수정한 단가 사용 중" : `기본 단가표 ${info.defaultVersion}`} · 모델 ID 앞부분이 일치하면 적용`
          : "USD / 100만 토큰"
      }
      right={
        <div className="row">
          <button className="btn" onClick={() => addModel()}>모델 추가</button>
          <button className="btn" disabled={busy || !api.inTauri} onClick={refresh} title="GitHub에 게시된 최신 단가표를 받아요">
            최신 단가 받기
          </button>
          <button className="btn" disabled={busy || !info?.custom} onClick={() => save(null)}>
            기본값으로
          </button>
          <button className="btn primary" disabled={!dirty || busy} onClick={() => save(p)}>{busy ? "다시 계산 중…" : "저장 후 다시 계산"}</button>
        </div>
      }
    >
      {msg && (
        <div className="notice info" style={{ marginBottom: 12 }}>
          {msg}
        </div>
      )}
      {missing.length > 0 && (
        <div className="notice" style={{ marginBottom: 12 }}>
          단가가 없는 모델:{" "}
          {missing.map((u) => (
            <button key={u.model} className="btn" style={{ margin: "2px 4px", padding: "1px 8px" }} onClick={() => addModel(u.model)}>
              + {u.model} <span className="muted">({fmtTokens(u.tokens)})</span>
            </button>
          ))}
        </div>
      )}
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>모델 ID</th>
              {PRICE_FIELDS.map(([, l]) => (
                <th key={l}>{l}</th>
              ))}
              <th title="입력이 이 토큰 수를 넘으면 요청 전체에 배수 적용 (0 = 없음)">긴 컨텍스트 기준</th>
              <th>입력 배수</th>
              <th>출력 배수</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {p.entries.map((e, i) => (
              <tr key={i}>
                <td>
                  <input className="inp wide" value={e.model} onChange={(ev) => upd(i, "model", ev.target.value)} />
                </td>
                {PRICE_FIELDS.map(([k]) => (
                  <td key={k}>
                    <input className="inp" type="number" step="0.01" value={e[k] as number} onChange={(ev) => upd(i, k, ev.target.value)} />
                  </td>
                ))}
                <td>
                  <input className="inp" type="number" value={e.long_ctx_threshold} onChange={(ev) => upd(i, "long_ctx_threshold", ev.target.value)} />
                </td>
                <td>
                  <input className="inp" type="number" step="0.1" value={e.long_input_mult} onChange={(ev) => upd(i, "long_input_mult", ev.target.value)} />
                </td>
                <td>
                  <input className="inp" type="number" step="0.1" value={e.long_output_mult} onChange={(ev) => upd(i, "long_output_mult", ev.target.value)} />
                </td>
                <td>
                  <button className="btn" style={{ padding: "1px 8px" }} title="삭제" onClick={() => setP({ ...p, entries: p.entries.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row muted" style={{ fontSize: 12.5, marginTop: 10 }}>
        <span>Claude 빠른 모드 배수</span>
        <input className="inp" style={{ width: 70 }} type="number" step="0.1" value={p.fast_mult} onChange={(e) => setP({ ...p, fast_mult: Number(e.target.value) || 1 })} />
        <span>· 웹 검색 1회당 $</span>
        <input className="inp" style={{ width: 70 }} type="number" step="0.001" value={p.web_search_usd} onChange={(e) => setP({ ...p, web_search_usd: Number(e.target.value) || 0 })} />
        <span>· Codex는 입력에 캐시 토큰이 포함돼 있어 미적용분만 입력 단가로 계산해요.</span>
      </div>
    </Card>
  );
}
