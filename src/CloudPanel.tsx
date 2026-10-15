import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { cloud, useCloud } from "./cloud";
import { fmtAgo, fmtDateTime } from "./format";
import { Card } from "./ui";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CloudPanel({ onboarding = false }: { onboarding?: boolean }) {
  const state = useCloud();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(state.url);
  const [key, setKey] = useState(state.anonKey);
  const [deviceName, setDeviceName] = useState(state.deviceName);
  const [email, setEmail] = useState(state.email ?? "");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const disabled = state.busy || pending !== null || !state.initialized;

  useEffect(() => {
    setUrl(state.url);
    setKey(state.anonKey);
    setDeviceName(state.deviceName);
  }, [state.url, state.anonKey, state.deviceName]);

  useEffect(() => {
    setPassword("");
    setError("");
    setMessage("");
  }, [state.url, state.anonKey, state.email, state.authenticated]);

  const run = async (name: string, action: () => Promise<void>, success = "") => {
    setPending(name);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(success);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(null);
    }
  };
  const signIn = (event: FormEvent) => {
    event.preventDefault();
    void run("login", async () => {
      await cloud.signIn(email.trim(), password);
      setPassword("");
    });
  };
  const configure = (event: FormEvent) => {
    event.preventDefault();
    void run("configure", () => cloud.configure({
      url: url.trim(), anonKey: key.trim(), deviceName: deviceName.trim(), enabled: state.enabled,
    }), "연결 설정을 저장했어요.");
  };

  return (
    <Card title={api.inTauri ? "모바일 · 클라우드 연결" : onboarding ? "내 기록 연결하기" : "클라우드 · 기기"}
      right={<span className={`source-pill ${state.authenticated ? "connected" : ""}`}>{state.authenticated ? "로그인됨" : "연결 전"}</span>}
      className="cloud-panel">
      <div className="cloud-stack">
        {!state.initialized && <div className="muted" role="status">저장된 연결을 확인하고 있어요…</div>}
        <p className="cloud-copy">
          {api.inTauri
            ? "이 PC의 사용량과 한도를 비공개 클라우드에 올려 휴대폰에서 확인하세요. 휴대폰에서도 같은 계정으로 로그인하면 돼요."
            : "PC에서 수집한 Claude Code와 Codex 기록을 가져와요. 기기를 하나씩 선택해 사용량, 한도, 예측을 볼 수 있어요."}
        </p>

        {state.configured && !state.authenticated && (
          <form className="cloud-form" onSubmit={signIn}>
            <div className="field">
              <label htmlFor={`${id}-email`}>클라우드 계정 이메일</label>
              <input id={`${id}-email`} className="inp" type="email" autoComplete="username" inputMode="email"
                required value={email} onChange={(event) => setEmail(event.target.value)} disabled={disabled} placeholder="you@example.com" />
            </div>
            <div className="field">
              <label htmlFor={`${id}-password`}>비밀번호</label>
              <input id={`${id}-password`} className="inp" type="password" autoComplete="current-password"
                required value={password} onChange={(event) => setPassword(event.target.value)} disabled={disabled} />
            </div>
            <button type="submit" className="btn primary cloud-submit" disabled={disabled || !email.trim() || !password}>
              {pending === "login" ? "로그인 중…" : "로그인하고 기록 가져오기"}
            </button>
            <span className="hint">설정된 클라우드에 등록된 계정을 사용하세요. Claude·OpenAI 로그인과는 별개예요.</span>
          </form>
        )}

        {state.authenticated && (
          <>
            <div className="cloud-account">
              <div><span className="muted">연결 계정</span><strong>{state.email ?? "로그인된 계정"}</strong></div>
              <button className="btn" disabled={disabled} onClick={() => void run("logout", () => cloud.signOut())}>
                {pending === "logout" ? "로그아웃 중…" : "로그아웃"}
              </button>
            </div>
            {api.inTauri ? (
              <>
                <label className="check cloud-toggle">
                  <input type="checkbox" checked={state.enabled} disabled={disabled}
                    onChange={(event) => void run("enable", () => cloud.setEnabled(event.target.checked))} />
                  이 PC에서 클라우드 동기화 사용
                </label>
                <div className="cloud-detail"><span>마지막 업로드</span><strong>{state.lastUploadAt ? `${fmtDateTime(state.lastUploadAt)} · ${fmtAgo(state.lastUploadAt)}` : "아직 업로드하지 않았어요"}</strong></div>
                <button className="btn primary" disabled={disabled || !state.enabled || state.offline}
                  onClick={() => void run("sync", () => cloud.syncNow(), "동기화를 요청했어요. 완료되면 마지막 업로드 시각이 바뀌어요.")}>
                  {pending === "sync" ? "동기화 중…" : "지금 동기화"}
                </button>
                {!state.persistentSession && <div className="notice">이 환경은 로그인 정보를 메모리에서만 유지해요. 앱을 다시 열면 로그인해야 해요.</div>}
              </>
            ) : (
              <>
                {state.devices.length > 0 ? (
                  <div className="field">
                    <label htmlFor={`${id}-device`}>보고 있는 PC</label>
                    <select id={`${id}-device`} className="inp" value={state.devices.some((device) => device.id === state.selectedDeviceId) ? state.selectedDeviceId ?? "" : ""} disabled={disabled}
                      onChange={(event) => void run("device", () => cloud.selectDevice(event.target.value))}>
                      {!state.devices.some((device) => device.id === state.selectedDeviceId) && <option value="" disabled>PC를 선택하세요</option>}
                      {state.devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {fmtAgo(device.capturedAt)} 캡처</option>)}
                    </select>
                    <span className="hint">선택한 PC의 기록만 표시해요. 기기별 사용량을 합산하지 않아요.</span>
                  </div>
                ) : (
                  <div className="notice info">아직 연결된 PC가 없어요. PC의 Token View 설정에서 같은 클라우드 계정으로 로그인하고 동기화를 켜 주세요.</div>
                )}
                <div className="row cloud-actions">
                  <button className="btn" disabled={disabled || state.offline} onClick={() => void run("refresh", () => cloud.refresh())}>
                    {pending === "refresh" ? "가져오는 중…" : state.mode === "cloud" ? "클라우드 새로고침" : "클라우드 기록으로 돌아가기"}
                  </button>
                  <button className="btn" disabled={disabled || state.offline || !state.selectedDeviceId}
                    onClick={() => void run("request", () => cloud.requestRefresh(), "PC에 요청했어요. PC가 실행 중이고 온라인이면 최신 한도를 수집해요.")}>
                    {pending === "request" ? "요청 중…" : "PC에 최신 한도 요청"}
                  </button>
                </div>
                {state.refreshRequestedAt && <div className="hint">마지막 PC 요청 {fmtAgo(state.refreshRequestedAt)} · 요청은 10분 후 만료돼요.</div>}
              </>
            )}
          </>
        )}

        {!state.configured && <div className="notice info">클라우드 연결 설정이 아직 없어요. PC와 같은 연결 주소를 설정하거나, JSON 파일 또는 샘플로 먼저 둘러보세요.</div>}
        <details className="cloud-advanced" open={!state.configured && api.inTauri ? true : undefined}>
          <summary>{state.configured ? "연결 설정 변경" : "클라우드 연결 설정"}<span>고급</span></summary>
          <form className="cloud-form" onSubmit={configure}>
            <p className="hint">PC와 휴대폰에 같은 Supabase 프로젝트 주소와 공개 키를 설정하세요. 키는 프로젝트 설정에서 확인할 수 있어요.</p>
            <div className="field">
              <label htmlFor={`${id}-url`}>Supabase URL</label>
              <input id={`${id}-url`} className="inp" type="url" autoComplete="off" inputMode="url" required
                placeholder="https://your-project.supabase.co" value={url} onChange={(event) => setUrl(event.target.value)} disabled={disabled} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-key`}>공개 anon / publishable key</label>
              <input id={`${id}-key`} className="inp" type="text" autoComplete="off" required spellCheck={false}
                placeholder="공개 키" value={key} onChange={(event) => setKey(event.target.value)} disabled={disabled} />
              <span className="hint">관리자용 service_role 키는 사용할 수 없어요.</span>
            </div>
            {api.inTauri && <div className="field">
              <label htmlFor={`${id}-device-name`}>이 PC 이름</label>
              <input id={`${id}-device-name`} className="inp" value={deviceName} maxLength={80}
                onChange={(event) => setDeviceName(event.target.value)} placeholder="내 PC" disabled={disabled} />
            </div>}
            <button type="submit" className="btn" disabled={disabled || !url.trim() || !key.trim()}>
              {pending === "configure" ? "저장 중…" : "연결 설정 저장"}
            </button>
          </form>
        </details>

        {!api.inTauri && <div className="cloud-files">
          <div className="cloud-divider"><span>{api.inTauri ? "스냅샷 내보내기" : "파일로 확인하기"}</span></div>
          {!api.inTauri && <p className="hint">클라우드 없이도 Token View 스냅샷 JSON을 가져올 수 있어요. 파일 데이터는 이 기기에 저장돼요.</p>}
          <div className="row cloud-actions">
            {!api.inTauri && <>
              <input ref={fileInput} type="file" accept=".json,application/json" className="visually-hidden" tabIndex={-1}
                aria-label="Token View 스냅샷 JSON 가져오기" onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void run("import", () => cloud.importFile(file));
                }} />
              <button className="btn" disabled={disabled} onClick={() => fileInput.current?.click()}>{pending === "import" ? "가져오는 중…" : "JSON 가져오기"}</button>
              <button className="btn" disabled={disabled} onClick={() => void run("demo", () => cloud.loadDemo())}>샘플 데이터 보기</button>
            </>}
            <button className="btn" disabled={disabled || !state.hasData} onClick={() => void run("download", () => cloud.downloadSnapshot(), "스냅샷 다운로드를 시작했어요.")}>JSON 다운로드</button>
          </div>
          {!api.inTauri && state.hasData && <div className="cloud-clear">
            {confirmClear ? <div className="cloud-stack">
              <p className="hint">이 기기에 저장된 스냅샷을 지울까요? 클라우드와 PC의 원본 기록은 유지돼요.</p>
              <div className="row">
                <button className="btn danger" disabled={disabled} onClick={() => void run("clear", async () => { await cloud.clearLocal(); setConfirmClear(false); })}>저장 데이터 지우기</button>
                <button className="btn" disabled={disabled} onClick={() => setConfirmClear(false)}>취소</button>
              </div>
            </div> : <button className="text-button" disabled={disabled} onClick={() => setConfirmClear(true)}>이 기기의 저장 데이터 지우기</button>}
          </div>}
        </div>}
        {(error || state.error) && <div className="notice cloud-error" role="alert">{error || state.error}</div>}
        {state.warning && <div className="notice">{state.warning}</div>}
        {message && <div className="notice info" role="status">{message}</div>}
      </div>
    </Card>
  );
}

export function BrowserSupportCard() {
  return <Card title="모바일에서 사용할 수 있는 기능" className="browser-support">
    <p>사용량·한도·예측 확인, 표시 통화·예산 설정, JSON 가져오기와 다운로드를 사용할 수 있어요.</p>
    <p className="muted">휴대폰에서 Claude·OpenAI 계정의 한도를 직접 조회하는 기능은 아직 검증되지 않았어요. 한도는 PC의 마지막 캡처를 표시하며, 최신 정보는 PC에 요청해 주세요.</p>
    <p className="muted">로그 수집, 실시간 한도 조회 설정, Windows 알림·시작 프로그램, 단가 수정은 PC 앱에서 설정하세요.</p>
    <div className="install-hint"><strong>홈 화면에 추가하기</strong><span>iPhone은 Safari의 공유 메뉴, Android는 브라우저 메뉴에서 ‘홈 화면에 추가’ 또는 ‘앱 설치’를 선택하세요.</span></div>
  </Card>;
}
