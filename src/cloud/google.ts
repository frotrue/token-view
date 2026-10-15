// Browser side of the Google Drive sync. The web build uses the OAuth implicit
// redirect (no backend, no third-party script); a future native mobile app can swap
// in a PKCE flow with refresh tokens behind the same `GoogleToken` shape.
import { AuthExpired, decodeJson, type RemoteFile } from './remote';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const SCOPES = `${DRIVE_SCOPE} https://www.googleapis.com/auth/userinfo.email`;
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com';
const STATE_KEY = 'tv-oauth-state';
const CLIENT_KEY = 'tv-google-client-id';

export interface GoogleToken { accessToken: string; expiresAt: number }
export interface GoogleAccount { userId: string; email: string | null }

function storageGet(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key: string, value: string | null) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage unavailable */ } }

export const validClientId = (id: string) => /^[A-Za-z0-9._-]{8,200}\.apps\.googleusercontent\.com$/.test(id.trim());
export function clientId(): string | null {
  const saved = storageGet(CLIENT_KEY);
  if (saved && validClientId(saved)) return saved;
  const built = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  return built && validClientId(built) ? built : null;
}
export function setClientId(id: string | null) {
  if (id !== null && !validClientId(id)) throw new Error('클라이언트 ID는 ….apps.googleusercontent.com 형식이어야 해요.');
  storageSet(CLIENT_KEY, id?.trim() ?? null);
}
export const customClientId = () => storageGet(CLIENT_KEY);
const redirectUri = () => `${location.origin}${import.meta.env.BASE_URL}`;

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Leaves the page for Google's consent screen; it comes back with `#access_token`. */
export function beginSignIn(loginHint?: string | null) {
  const id = clientId();
  if (!id) throw new Error('구글 클라이언트 ID가 설정되지 않았어요.');
  const state = randomState();
  try { sessionStorage.setItem(STATE_KEY, state); } catch { throw new Error('이 브라우저에서는 로그인 상태를 저장할 수 없어요.'); }
  const params = new URLSearchParams({
    client_id: id, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPES,
    state, include_granted_scopes: 'true',
  });
  // Reconnecting a known account usually returns immediately without a chooser.
  if (loginHint) params.set('login_hint', loginHint);
  else params.set('prompt', 'select_account');
  location.assign(`${AUTH_URL}?${params}`);
}

/** Reads (and removes) an OAuth response from the URL fragment, if any. */
export function completeSignIn(): GoogleToken | null {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  const params = new URLSearchParams(hash);
  if (!params.has('access_token') && !params.has('error')) return null;
  history.replaceState(null, '', location.pathname + location.search);
  let expected: string | null = null;
  try { expected = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch { /* handled below */ }
  if (!expected || params.get('state') !== expected) throw new Error('로그인 응답을 확인하지 못했어요. 다시 시도해 주세요.');
  const error = params.get('error');
  if (error === 'access_denied') throw new Error('구글 연결을 허용하지 않았어요.');
  if (error === 'interaction_required' || error === 'login_required' || error === 'consent_required') throw new AuthExpired('구글 로그인이 만료됐어요. 다시 연결해 주세요.');
  if (error) throw new Error('구글 연결에 실패했어요. 다시 시도해 주세요.');
  const scope = params.get('scope') ?? '';
  if (!scope.split(' ').includes(DRIVE_SCOPE)) throw new Error('구글 드라이브 권한을 허용해야 기록을 볼 수 있어요.');
  const seconds = Number(params.get('expires_in'));
  const accessToken = params.get('access_token') ?? '';
  if (!accessToken || !Number.isFinite(seconds) || seconds <= 0) throw new Error('구글 로그인 응답이 올바르지 않아요.');
  return { accessToken, expiresAt: Date.now() + Math.min(seconds, 86_400) * 1000 };
}

async function call(token: GoogleToken, url: string, init: RequestInit = {}) {
  if (token.expiresAt <= Date.now() + 30_000) throw new AuthExpired('구글 로그인이 만료됐어요. 다시 연결해 주세요.');
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(20_000) });
  } catch { throw new Error('구글 드라이브에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.'); }
  if (response.status === 401) throw new AuthExpired('구글 로그인이 만료됐어요. 다시 연결해 주세요.');
  if (!response.ok) throw new Error(`구글 드라이브 요청에 실패했어요 (HTTP ${response.status}).`);
  return response;
}

export async function account(token: GoogleToken): Promise<GoogleAccount> {
  const value = await (await call(token, `${API}/oauth2/v3/userinfo`)).json();
  if (typeof value?.sub !== 'string' || !value.sub) throw new Error('구글 계정 정보를 확인하지 못했어요.');
  return { userId: value.sub, email: typeof value.email === 'string' ? value.email : null };
}

export async function listFiles(token: GoogleToken): Promise<RemoteFile[]> {
  const fields = 'files(id,name,modifiedTime,appProperties)';
  const value = await (await call(token, `${API}/drive/v3/files?spaces=appDataFolder&pageSize=1000&fields=${encodeURIComponent(fields)}`)).json();
  const files: unknown[] = Array.isArray(value?.files) ? value.files : [];
  return files.flatMap((f) => {
    const file = f as Partial<RemoteFile>;
    if (typeof file.id !== 'string' || typeof file.name !== 'string') return [];
    const props: Record<string, string> = {};
    for (const [k, v] of Object.entries(file.appProperties ?? {})) if (typeof v === 'string') props[k] = v;
    return [{ id: file.id, name: file.name, modifiedTime: typeof file.modifiedTime === 'string' ? file.modifiedTime : '', appProperties: props }];
  });
}

/** Downloads a file; gzip content (what the PC uploads) is inflated in the browser. */
export async function downloadJson(token: GoogleToken, id: string): Promise<unknown> {
  const response = await call(token, `${API}/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
  return decodeJson(response);
}

/** Creates (id = null) or updates a metadata-only appDataFolder file. */
export async function putProps(token: GoogleToken, id: string | null, name: string, props: Record<string, string>): Promise<RemoteFile> {
  const fields = 'id,name,modifiedTime,appProperties';
  const body = id ? { appProperties: props } : { name, parents: ['appDataFolder'], appProperties: props };
  const url = id ? `${API}/drive/v3/files/${encodeURIComponent(id)}?fields=${fields}` : `${API}/drive/v3/files?fields=${fields}`;
  const value = await (await call(token, url, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  return { id: String(value.id), name: String(value.name ?? name), modifiedTime: String(value.modifiedTime ?? ''), appProperties: value.appProperties ?? props };
}

/**
 * Android app: a token from Google Play services (see mobile/plugin-google-auth).
 * Once consent is given, `interactive: false` renews it without any UI.
 */
export async function nativeAuthorize(interactive: boolean): Promise<GoogleToken> {
  const { invoke } = await import('@tauri-apps/api/core');
  let result: { accessToken?: string; scopes?: string };
  try { result = await invoke('plugin:google-auth|authorize', { interactive }); }
  catch (error) {
    const text = String(error);
    if (/consent_required|cancelled|superseded/.test(text)) throw new AuthExpired('구글 연결이 필요해요. 구글 계정으로 연결을 눌러 주세요.');
    throw new Error(`구글 연결에 실패했어요. (${text.slice(0, 120)})`);
  }
  if (!result.accessToken) throw new Error('구글 로그인 응답이 올바르지 않아요.');
  if (result.scopes && !result.scopes.split(' ').includes(DRIVE_SCOPE)) throw new Error('구글 드라이브 권한을 허용해야 기록을 볼 수 있어요.');
  // Play services tokens last about an hour; renew a little early.
  return { accessToken: result.accessToken, expiresAt: Date.now() + 50 * 60_000 };
}

export async function revoke(token: GoogleToken) {
  try {
    await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(token.accessToken)}`, signal: AbortSignal.timeout(10_000) });
  } catch { /* the local sign-out still completes */ }
}

export const newNonce = randomState;
