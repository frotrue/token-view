import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { cloud, useCloud } from "./cloud";
import { fmtAgo, fmtDateTime } from "./format";
import { Card } from "./ui";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const kb = (bytes: number) => bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)}KB`;

export function CloudPanel({ onboarding = false }: { onboarding?: boolean }) {
  const state = useCloud();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [deviceName, setDeviceName] = useState(state.deviceName);
  const [clientId, setClientId] = useState(state.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [repo, setRepo] = useState(state.githubRepo);
  const [pat, setPat] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const disabled = state.busy || pending !== null || !state.initialized;
  const desktop = api.inTauri;

  useEffect(() => { setDeviceName(state.deviceName); }, [state.deviceName]);
  useEffect(() => { setClientId(state.clientId); setClientSecret(""); }, [state.clientId]);
  useEffect(() => { setError(""); setMessage(""); setPat(""); }, [state.email, state.authenticated]);
  useEffect(() => { if (state.githubRepo) setRepo(state.githubRepo); }, [state.githubRepo]);

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
  const saveDesktop = (event: FormEvent) => {
    event.preventDefault();
    void run("configure", () => cloud.configureDesktop({ deviceName, enabled: state.enabled, clientId, clientSecret }), "설정을 저장했어요.");
  };
  const saveClient = (event: FormEvent) => {
    event.preventDefault();
    void run("client", () => cloud.setClientId(clientId.trim() || null), "클라이언트 ID를 저장했어요.");
  };
  const connectGithub = (event: FormEvent) => {
    event.preventDefault();
    void run("github", async () => { await cloud.connectGithub(repo, pat); setPat(""); });
  };
  const connected = state.authenticated || state.needsReconnect;
  const github = state.provider === "github";

  return (
    <Card title={desktop ? "휴대폰 연결" : onboarding ? "내 기록 연결하기" : "연결 · 기기"}
      right={<span className={`source-pill ${state.authenticated ? "connected" : ""}`}>{state.authenticated ? "연결됨" : state.needsReconnect ? "다시 연결 필요" : "연결 전"}</span>}
      className="cloud-panel">
      <div className="cloud-stack">
        {!state.initialized && <div className="muted" role="status">저장된 연결을 확인하고 있어요…</div>}
        <p className="cloud-copy">
          {desktop
            ? "이 PC의 사용량과 한도를 내 구글 드라이브의 숨겨진 앱 전용 공간(또는 내 GitHub 비공개 저장소)에 올려 휴대폰에서 확인하세요."
            : "PC가 내 구글 드라이브나 GitHub 비공개 저장소에 올린 Claude Code·Codex 기록을 가져와요. PC와 같은 곳으로 연결하세요."}
        </p>

        {!connected && state.available && (
          <div className="cloud-form">
            <button className="btn primary cloud-submit" disabled={disabled || state.signingIn || (!desktop && state.offline)}
              onClick={() => void run("login", () => cloud.signIn())}>
              {state.signingIn || pending === "login" ? (desktop ? "브라우저에서 계속하세요…" : "구글로 이동 중…") : "구글 계정으로 연결"}
            </button>
            {desktop && state.signingIn && (
              <div className="row">
                <span className="hint">열린 브라우저에서 계정을 선택하고 허용을 누르면 자동으로 연결돼요.</span>
                <button className="text-button" onClick={() => cloud.cancelSignIn()}>취소</button>
              </div>
            )}
            <span className="hint">권한은 이 앱 전용 숨김 폴더뿐이에요. Claude·OpenAI 로그인과는 별개예요.</span>
          </div>
        )}
        {!state.available && state.initialized && (
          <div className="notice info">이 빌드에는 구글 클라이언트 ID가 없어요. 아래 GitHub 저장소로 연결하거나, 고급 설정에서 ID를 입력하세요.</div>
        )}

        {connected && (
          <>
            <div className="cloud-account">
              <div><span className="muted">{github ? "연결된 GitHub 저장소" : "연결된 구글 계정"}</span><strong>{github ? state.githubRepo : state.email ?? "구글 계정"}</strong></div>
              {state.needsReconnect && !github && (
                <button className="btn primary" disabled={disabled || state.offline} onClick={() => void run("login", () => cloud.signIn())}>
                  {pending === "login" ? "구글로 이동 중…" : "다시 연결"}
                </button>
              )}
              <button className="btn" disabled={disabled} onClick={() => void run("logout", () => cloud.signOut())}>
                {pending === "logout" ? "해제 중…" : "연결 해제"}
              </button>
            </div>
            {state.needsReconnect && !github && <span className="hint">웹에서는 구글 연결이 1시간 동안 유지돼요. 저장된 기록은 그대로 볼 수 있어요.</span>}
            {desktop ? (
              <>
                <label className="check cloud-toggle">
                  <input type="checkbox" checked={state.enabled} disabled={disabled}
                    onChange={(event) => void run("enable", () => cloud.setEnabled(event.target.checked))} />
                  이 PC에서 동기화 사용
                </label>
                <div className="cloud-detail"><span>마지막 업로드</span><strong>{state.lastUploadAt ? `${fmtDateTime(state.lastUploadAt)} · ${fmtAgo(state.lastUploadAt)}${state.lastUploadBytes ? ` · ${kb(state.lastUploadBytes)}` : ""}` : "아직 업로드하지 않았어요"}</strong></div>
                <div className="cloud-detail"><span>마지막 확인</span><strong>{state.lastCheckAt ? fmtAgo(state.lastCheckAt) : "-"}</strong></div>
                <span className="hint">바뀐 내용이 있을 때만 최대 5분마다 압축해서 올려요. 변화가 없으면 "확인 시각"만 갱신해요.</span>
                <button className="btn primary" disabled={disabled || !state.enabled || state.offline}
                  onClick={() => void run("sync", () => cloud.syncNow(), "동기화를 요청했어요. 완료되면 마지막 업로드 시각이 바뀌어요.")}>
                  {pending === "sync" ? "동기화 중…" : "지금 동기화"}
                </button>
                {!state.persistentSession && <div className="notice">이 환경은 로그인 정보를 메모리에서만 유지해요. 앱을 다시 열면 다시 연결해야 해요.</div>}
              </>
            ) : (
              <>
                {state.devices.length > 0 ? (
                  <div className="field">
                    <label htmlFor={`${id}-device`}>보고 있는 PC</label>
                    <select id={`${id}-device`} className="inp" value={state.devices.some((device) => device.id === state.selectedDeviceId) ? state.selectedDeviceId ?? "" : ""} disabled={disabled}
                      onChange={(event) => void run("device", () => cloud.selectDevice(event.target.value))}>
                      {!state.devices.some((device) => device.id === state.selectedDeviceId) && <option value="" disabled>PC를 선택하세요</option>}
                      {state.devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {fmtAgo(device.checkedAt)} 확인</option>)}
                    </select>
                    <span className="hint">선택한 PC의 기록만 표시해요. 기기별 사용량을 합산하지 않아요.</span>
                  </div>
                ) : state.authenticated ? (
                  <div className="notice info">아직 올라온 PC 기록이 없어요. PC의 Token View 설정 → 휴대폰 연결에서 같은 {github ? "저장소" : "구글 계정"}로 연결해 주세요.</div>
                ) : null}
                <div className="row cloud-actions">
                  <button className="btn" disabled={disabled || state.offline || !state.authenticated} onClick={() => void run("refresh", () => cloud.refresh())}>
                    {pending === "refresh" ? "가져오는 중…" : state.mode === "cloud" ? "기록 새로고침" : "연결된 기록으로 돌아가기"}
                  </button>
                  <button className="btn" disabled={disabled || state.offline || !state.authenticated || !state.selectedDeviceId}
                    onClick={() => void run("request", () => cloud.requestRefresh(), "PC에 요청했어요. PC가 켜져 있으면 1~2분 안에 최신 한도를 올려요.")}>
                    {pending === "request" ? "요청 중…" : "PC에 최신 한도 요청"}
                  </button>
                </div>
                {state.refreshRequestedAt && <div className="hint">마지막 PC 요청 {fmtAgo(state.refreshRequestedAt)} · 요청은 10분 후 만료돼요.</div>}
              </>
            )}
          </>
        )}

        {(!connected || (state.needsReconnect && github)) && (
          <details className="cloud-advanced" open={(!state.available && state.initialized) || (state.needsReconnect && github) ? true : undefined}>
            <summary>GitHub 비공개 저장소로 연결<span>구글 대신</span></summary>
            <form className="cloud-form" onSubmit={connectGithub}>
              <p className="hint">README가 있는 비공개 저장소와, 그 저장소 하나에만 Contents 읽기·쓰기 권한을 준 fine-grained 토큰이 필요해요. PC와 휴대폰에 같은 저장소를 입력하세요.</p>
              <div className="field">
                <label htmlFor={`${id}-repo`}>저장소 (owner/name)</label>
                <input id={`${id}-repo`} className="inp" autoComplete="off" spellCheck={false} value={repo}
                  onChange={(event) => setRepo(event.target.value)} placeholder="me/token-view-data" disabled={disabled} />
              </div>
              <div className="field">
                <label htmlFor={`${id}-pat`}>GitHub 토큰</label>
                <input id={`${id}-pat`} className="inp" type="password" autoComplete="off" spellCheck={false} value={pat}
                  onChange={(event) => setPat(event.target.value)} placeholder="github_pat_…" disabled={disabled} />
                <span className="hint">{desktop ? "토큰은 Windows 자격 증명 관리자에 저장돼요." : "토큰은 이 기기의 브라우저에만 저장돼요."} 기록은 저장소의 tv-로 시작하는 브랜치에 덮어써서 커밋 기록이 쌓이지 않아요.</span>
              </div>
              <button type="submit" className="btn" disabled={disabled || !repo.trim() || !pat.trim()}>
                {pending === "github" ? "확인 중…" : "GitHub 저장소 연결"}
              </button>
            </form>
          </details>
        )}

        <details className="cloud-advanced" open={!state.available && state.initialized && desktop ? true : undefined}>
          <summary>{desktop ? "PC 이름 · 연결 설정" : "구글 클라이언트 ID"}<span>고급</span></summary>
          {desktop ? (
            <form className="cloud-form" onSubmit={saveDesktop}>
              <div className="field">
                <label htmlFor={`${id}-device-name`}>이 PC 이름</label>
                <input id={`${id}-device-name`} className="inp" value={deviceName} maxLength={64}
                  onChange={(event) => setDeviceName(event.target.value)} placeholder="내 PC" disabled={disabled} />
                <span className="hint">휴대폰에서 PC를 고를 때 보이는 이름이에요.</span>
              </div>
              <div className="field">
                <label htmlFor={`${id}-client`}>구글 OAuth 클라이언트 ID (선택)</label>
                <input id={`${id}-client`} className="inp" autoComplete="off" spellCheck={false} value={clientId}
                  onChange={(event) => setClientId(event.target.value)} placeholder={state.customClient ? "" : "기본 클라이언트 사용"} disabled={disabled} />
              </div>
              {clientId.trim() !== "" && <div className="field">
                <label htmlFor={`${id}-secret`}>클라이언트 보안 비밀번호</label>
                <input id={`${id}-secret`} className="inp" type="password" autoComplete="off" spellCheck={false} value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)} placeholder={state.customClient ? "변경할 때만 입력" : "GOCSPX-…"} disabled={disabled} />
                <span className="hint">직접 만든 "데스크톱 앱" 유형 클라이언트를 쓸 때만 입력하세요. 클라이언트를 바꾸면 다시 연결해야 해요.</span>
              </div>}
              <button type="submit" className="btn" disabled={disabled || !deviceName.trim()}>
                {pending === "configure" ? "저장 중…" : "연결 설정 저장"}
              </button>
            </form>
          ) : (
            <form className="cloud-form" onSubmit={saveClient}>
              <p className="hint">직접 배포한 웹앱이라면 구글 클라우드의 "웹 애플리케이션" 클라이언트 ID를 입력하세요. PC 앱과 같은 프로젝트여야 같은 기록을 볼 수 있어요.</p>
              <div className="field">
                <label htmlFor={`${id}-client`}>클라이언트 ID</label>
                <input id={`${id}-client`} className="inp" autoComplete="off" spellCheck={false} value={clientId}
                  onChange={(event) => setClientId(event.target.value)} placeholder="….apps.googleusercontent.com" disabled={disabled} />
              </div>
              <button type="submit" className="btn" disabled={disabled}>{pending === "client" ? "저장 중…" : "클라이언트 ID 저장"}</button>
            </form>
          )}
        </details>

        {!desktop && <div className="cloud-files">
          <div className="cloud-divider"><span>파일로 확인하기</span></div>
          <p className="hint">구글 연결 없이도 Token View 스냅샷 JSON을 가져올 수 있어요. 파일 데이터는 이 기기에 저장돼요.</p>
          <div className="row cloud-actions">
            <input ref={fileInput} type="file" accept=".json,application/json" className="visually-hidden" tabIndex={-1}
              aria-label="Token View 스냅샷 JSON 가져오기" onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void run("import", () => cloud.importFile(file));
              }} />
            <button className="btn" disabled={disabled} onClick={() => fileInput.current?.click()}>{pending === "import" ? "가져오는 중…" : "JSON 가져오기"}</button>
            <button className="btn" disabled={disabled} onClick={() => void run("demo", () => cloud.loadDemo())}>샘플 데이터 보기</button>
            <button className="btn" disabled={disabled || !state.hasData} onClick={() => void run("download", () => cloud.downloadSnapshot(), "스냅샷 다운로드를 시작했어요.")}>JSON 다운로드</button>
          </div>
          {state.hasData && <div className="cloud-clear">
            {confirmClear ? <div className="cloud-stack">
              <p className="hint">이 기기에 저장된 스냅샷을 지울까요? 구글 드라이브와 PC의 원본 기록은 유지돼요.</p>
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
    <p className="muted">한도는 PC의 마지막 기록을 표시해요. 최신 정보가 필요하면 "PC에 최신 한도 요청"을 눌러 주세요.</p>
    <p className="muted">로그 수집, 실시간 한도 조회 설정, Windows 알림·시작 프로그램, 단가 수정은 PC 앱에서 설정하세요.</p>
    <div className="install-hint"><strong>홈 화면에 추가하기</strong><span>iPhone은 Safari의 공유 메뉴, Android는 브라우저 메뉴에서 ‘홈 화면에 추가’ 또는 ‘앱 설치’를 선택하세요.</span></div>
  </Card>;
}
