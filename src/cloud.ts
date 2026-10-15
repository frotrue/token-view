import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_SETTINGS, type UiSettings } from './cloud/models';
import type { CloudDevice, CloudSnapshot, CloudViewState, DesktopCloudStatus, DesktopConfiguration, SharedSettings } from './cloud/types';
import { MAX_SNAPSHOT_BYTES, parseDashboard, parseSnapshot, sharedSettings } from './cloud/schema';
import { clearCache, readCache, writeCache } from './cloud/cache';
import { emptyPricing, makeDemoSnapshot } from './cloud/demo';
import * as google from './cloud/google';

export type { CloudViewState, CloudSnapshot } from './cloud/types';
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const TOKEN_KEY = 'tv-google-token-v1';
const ACCOUNT_KEY = 'tv-google-account-v1';
const LOCAL_MODE = 'tv-local-mode-v1';
const POLL_MS = 180_000;
const SNAPSHOT_PREFIX = 'tv-snapshot-';
const SETTINGS_NAME = 'tv-settings';
const SHARED_KEYS = ['currency', 'krwRate', 'monthlyBudget', 'budgetClaude', 'budgetCodex'] as const;
const requestName = (deviceId: string) => `tv-request-${deviceId}`;

let state: CloudViewState = {
  mode: isDesktop ? 'desktop' : 'cloud', initialized: false,
  available: !isDesktop && google.clientId() !== null, customClient: false, clientId: '',
  authenticated: false, needsReconnect: false, signingIn: false,
  email: null, deviceName: '', enabled: false, persistentSession: false,
  devices: [], selectedDeviceId: null, busy: false, error: null, warning: null,
  offline: typeof navigator !== 'undefined' && !navigator.onLine,
  lastFetchedAt: null, capturedAt: null, lastUploadAt: null, lastCheckAt: null, lastUploadBytes: null,
  refreshRequestedAt: null, hasData: false,
};
if (!isDesktop) { const custom = google.customClientId(); state = { ...state, customClient: !!custom, clientId: custom ?? '' }; }
/** What the UI shows (capture time advanced by the PC's "unchanged" checks). */
let current: CloudSnapshot | null = null;
/** The snapshot exactly as downloaded, to avoid re-downloading unchanged content. */
let base: CloudSnapshot | null = null;
let token: google.GoogleToken | null = null;
let account: google.GoogleAccount | null = null;
let driveFiles = { settings: null as google.DriveFile | null, requests: new Map<string, google.DriveFile>() };
let pendingNonce: string | null = null;
let initial: Promise<void> | null = null;
let revision = 0;
let inFlight: Promise<void> | null = null;
let lastAttempt = 0;
let failureCount = 0;
let schedulePolling = () => {};
const listeners = new Set<() => void>();
const dataListeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
function patch(values: Partial<CloudViewState>) { state = { ...state, ...values }; notify(); schedulePolling(); }
function changed() { dataListeners.forEach((listener) => listener()); }
function storageGet(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key: string, value: string | null) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* session-only when browser storage is unavailable */ } }
const selectedKey = () => `tv-selected:${account?.userId ?? ''}`;
const cacheKey = (deviceId: string) => `google|${account?.userId ?? ''}|${deviceId}`;
const message = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : '연결을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.';
const hasToken = () => !!token && token.expiresAt > Date.now() + 30_000;

function readJson<T>(key: string, check: (v: unknown) => v is T): T | null {
  try { const v = JSON.parse(storageGet(key) ?? 'null'); return check(v) ? v : null; } catch { return null; }
}
const isToken = (v: unknown): v is google.GoogleToken => typeof (v as google.GoogleToken)?.accessToken === 'string' && Number.isFinite((v as google.GoogleToken)?.expiresAt);
const isAccount = (v: unknown): v is google.GoogleAccount => typeof (v as google.GoogleAccount)?.userId === 'string' && !!(v as google.GoogleAccount).userId;

async function action(task: () => Promise<void>) {
  patch({ busy: true, error: null });
  try { await task(); } catch (error) { patch({ error: message(error) }); throw error; }
  finally { patch({ busy: false }); }
}

function nativeStatus(value: DesktopCloudStatus) {
  patch({ available: value.available, customClient: value.customClient, clientId: value.clientId, enabled: value.enabled,
    deviceName: value.deviceName, authenticated: value.authenticated, signingIn: value.signingIn, email: value.email,
    lastUploadAt: value.lastUploadAt, lastCheckAt: value.lastCheckAt, lastUploadBytes: value.lastUploadBytes,
    error: value.lastError, persistentSession: value.persistentSession, mode: 'desktop' });
}

/** The token expired (they last an hour on the web): keep data, offer a one-tap reconnect. */
function expire() {
  token = null; storageSet(TOKEN_KEY, null);
  patch({ authenticated: false, needsReconnect: !!account, error: account ? null : '구글 로그인이 만료됐어요. 다시 연결해 주세요.' });
}

function forgetAccount() {
  revision++; inFlight = null; current = null; base = null; token = null; account = null; pendingNonce = null;
  driveFiles = { settings: null, requests: new Map() };
  patch({ authenticated: false, needsReconnect: false, email: null, hasData: false, devices: [], selectedDeviceId: null, capturedAt: null, lastFetchedAt: null, refreshRequestedAt: null, warning: null });
  changed();
}

function installSnapshot(value: CloudSnapshot, mode: CloudViewState['mode'] = state.mode) {
  current = value;
  const expiredRequest = state.refreshRequestedAt && Date.now() - state.refreshRequestedAt > 10 * 60_000;
  if (expiredRequest) pendingNonce = null;
  patch({ hasData: true, capturedAt: value.capturedAt, mode, selectedDeviceId: value.device.id,
    ...(expiredRequest ? { refreshRequestedAt: null } : {}) });
  changed();
}

async function storeSnapshot(key: string, value: CloudSnapshot) {
  try { await writeCache(key, value); }
  catch { patch({ warning: '기기 저장소를 사용할 수 없어 오프라인 보관이 제한돼요.' }); }
}

function settingsFromProps(props: Record<string, string> | undefined): SharedSettings | null {
  if (!props) return null;
  try {
    const value: Record<string, unknown> = {};
    for (const key of SHARED_KEYS) {
      const text = props[key];
      if (text === undefined) return null;
      value[key] = key === 'currency' ? text : text === '' ? null : Number(text);
    }
    return sharedSettings(value);
  } catch { return null; }
}

function devicesFrom(files: google.DriveFile[]) {
  const byDevice = new Map<string, CloudDevice & { fileId: string; props: Record<string, string> }>();
  for (const f of files) {
    if (!f.name.startsWith(SNAPSHOT_PREFIX) || f.appProperties.tv !== 'snapshot') continue;
    const id = f.appProperties.deviceId || f.name.slice(SNAPSHOT_PREFIX.length);
    const capturedAt = Number(f.appProperties.capturedAt) || 0;
    const checkedAt = Math.max(Number(f.appProperties.checkedAt) || 0, capturedAt);
    const device = { id, name: f.appProperties.deviceName || 'PC', capturedAt, checkedAt, fileId: f.id, props: f.appProperties };
    const existing = byDevice.get(id);
    if (!existing || existing.checkedAt < checkedAt) byDevice.set(id, device);
  }
  return [...byDevice.values()].sort((a, b) => b.checkedAt - a.checkedAt);
}
function newest(files: google.DriveFile[], name: string) {
  return files.filter((f) => f.name === name).sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))[0] ?? null;
}

async function fetchSnapshot() {
  if (!account || state.mode !== 'cloud') return;
  if (!navigator.onLine) { patch({ offline: true }); return; }
  if (!hasToken()) { expire(); return; }
  const connection = token!;
  const ownRevision = revision;
  lastAttempt = Date.now();
  let files: google.DriveFile[];
  try { files = await google.listFiles(connection); }
  catch (error) {
    if (ownRevision !== revision) return;
    if (error instanceof google.AuthExpired) { expire(); return; }
    failureCount++; throw new Error('구글 드라이브에서 기록을 가져오지 못했어요. 연결 상태를 확인해 주세요.');
  }
  if (ownRevision !== revision) return;
  const devices = devicesFrom(files);
  driveFiles = { settings: newest(files, SETTINGS_NAME), requests: new Map(files.filter((f) => f.name.startsWith('tv-request-')).map((f) => [f.name, f])) };
  patch({ devices: devices.map(({ id, name, capturedAt, checkedAt }) => ({ id, name, capturedAt, checkedAt })) });
  const selected = devices.find((d) => d.id === state.selectedDeviceId) ?? devices[0];
  if (!selected) {
    failureCount = 0; current = null; base = null;
    patch({ hasData: false, capturedAt: null, selectedDeviceId: null, lastFetchedAt: Date.now(), error: null });
    changed(); return;
  }
  // Same capture as what we hold: only the PC's "still unchanged" mark moved.
  let raw = base?.device.id === selected.id && base.capturedAt === selected.capturedAt ? base : null;
  if (!raw) {
    let downloaded: unknown;
    try { downloaded = await google.downloadJson(connection, selected.fileId); }
    catch (error) {
      if (ownRevision !== revision) return;
      if (error instanceof google.AuthExpired) { expire(); return; }
      failureCount++; throw new Error('선택한 PC의 기록을 가져오지 못했어요.');
    }
    if (ownRevision !== revision) return;
    raw = parseSnapshot(downloaded);
    if (raw.device.id !== selected.id) throw new Error('기기 정보가 일치하지 않아 데이터를 표시하지 않았어요.');
  }
  let value = raw;
  const checked = Number(selected.props.checkedAt);
  if (Number(selected.props.capturedAt) === raw.capturedAt && checked > raw.capturedAt && checked <= Date.now() + 5 * 60_000) {
    value = { ...raw, capturedAt: checked, dashboard: { ...raw.dashboard, now: checked } };
  }
  const shared = settingsFromProps(driveFiles.settings?.appProperties);
  if (shared) value = { ...value, settings: shared };
  if (current?.device.id === value.device.id && current.capturedAt > value.capturedAt) {
    patch({ lastFetchedAt: Date.now(), warning: '드라이브에 더 오래된 기록이 있어 이 기기의 최신 기록을 유지했어요.' });
    return;
  }
  failureCount = 0; base = raw;
  // Only the PC's own acknowledgement of this exact request completes it.
  if (pendingNonce && selected.props.handled === pendingNonce) { pendingNonce = null; patch({ refreshRequestedAt: null }); }
  storageSet(selectedKey(), value.device.id);
  patch({ lastFetchedAt: Date.now(), offline: false, error: null, warning: null });
  installSnapshot(value, 'cloud');
  await storeSnapshot(cacheKey(value.device.id), value);
}

async function refresh() {
  if (isDesktop) { nativeStatus(await invoke<DesktopCloudStatus>('cloud_status')); return; }
  if (inFlight) return inFlight;
  const request = fetchSnapshot().finally(() => { if (inFlight === request) inFlight = null; schedulePolling(); });
  inFlight = request;
  return inFlight;
}

async function restoreAccount() {
  const ownRevision = revision;
  patch({ authenticated: hasToken(), needsReconnect: !!account && !hasToken(), email: account?.email ?? null });
  if (!account || state.mode !== 'cloud') return;
  const deviceId = storageGet(selectedKey());
  if (deviceId) {
    patch({ selectedDeviceId: deviceId });
    const cached = await readCache(cacheKey(deviceId));
    if (ownRevision !== revision) return;
    if (cached) installSnapshot(cached, 'cloud');
  }
  if (hasToken()) await refresh();
}

async function initialize() {
  if (initial) return initial;
  initial = (async () => {
    try {
      if (isDesktop) {
        nativeStatus(await invoke<DesktopCloudStatus>('cloud_status'));
        const { listen } = await import('@tauri-apps/api/event');
        await listen('cloud-status', () => { void refresh().catch(() => {}); });
      } else {
        account = readJson(ACCOUNT_KEY, isAccount);
        token = readJson(TOKEN_KEY, isToken);
        if (token && !hasToken()) { token = null; storageSet(TOKEN_KEY, null); }
        const localMode = storageGet(LOCAL_MODE);
        try {
          const fresh = google.completeSignIn();
          if (fresh) {
            const who = await google.account(fresh);
            // A different Google account must never see the previous one's cache.
            if (account && account.userId !== who.userId) { await clearCache().catch(() => {}); }
            account = who; token = fresh;
            storageSet(ACCOUNT_KEY, JSON.stringify(who)); storageSet(TOKEN_KEY, JSON.stringify(fresh)); storageSet(LOCAL_MODE, null);
            patch({ mode: 'cloud' });
          } else if (localMode === 'import' || localMode === 'demo') {
            const cached = await readCache('local');
            if (cached) installSnapshot(cached, localMode);
          }
        } catch (error) { patch({ error: message(error) }); }
        await restoreAccount();
        window.addEventListener('storage', (event) => {
          // Another tab signed out or switched accounts: drop this tab's private data.
          if (event.key !== ACCOUNT_KEY && event.key !== null) {
            if (event.key === TOKEN_KEY) { token = readJson(TOKEN_KEY, isToken); patch({ authenticated: hasToken(), needsReconnect: !!account && !hasToken() }); }
            return;
          }
          const next = readJson(ACCOUNT_KEY, isAccount);
          if (next?.userId === account?.userId) return;
          forgetAccount(); account = next; token = readJson(TOKEN_KEY, isToken);
          void restoreAccount().catch((error) => patch({ error: message(error) }));
        });
      }
    } catch (error) { patch({ error: message(error) }); }
    finally { patch({ initialized: true }); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const maybeRefresh = () => {
      patch({ offline: !navigator.onLine });
      if (state.refreshRequestedAt && Date.now() - state.refreshRequestedAt >= 10 * 60_000) { pendingNonce = null; patch({ refreshRequestedAt: null }); }
      if (document.visibilityState === 'hidden' || !navigator.onLine) return;
      void refresh().catch((error) => patch({ error: message(error) })).finally(schedulePolling);
    };
    schedulePolling = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden' || !navigator.onLine) return;
      if (!isDesktop && (!account || !token || state.mode !== 'cloud' || inFlight)) return;
      const interval = Math.min(POLL_MS * 2 ** Math.min(failureCount, 3), 15 * 60_000);
      // Anchor to the actual read, not page startup: a later sign-in must not miss the first deadline.
      const delay = isDesktop ? 15_000 : Math.max(50, (lastAttempt || Date.now()) + interval - Date.now());
      timer = setTimeout(maybeRefresh, delay);
    };
    schedulePolling();
    window.addEventListener('online', maybeRefresh);
    window.addEventListener('offline', () => patch({ offline: true }));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') maybeRefresh(); else schedulePolling(); });
  })();
  return initial;
}

async function signIn() {
  if (isDesktop) {
    await action(async () => { nativeStatus(await invoke<DesktopCloudStatus>('cloud_sign_in')); });
    return;
  }
  await action(async () => {
    patch({ signingIn: true });
    google.beginSignIn(account?.email); // navigates away
  });
}

async function signOut() {
  if (isDesktop) { await action(async () => { nativeStatus(await invoke<DesktopCloudStatus>('cloud_sign_out')); }); return; }
  await action(async () => {
    const old = token;
    forgetAccount();
    storageSet(TOKEN_KEY, null); storageSet(ACCOUNT_KEY, null); storageSet(LOCAL_MODE, null);
    patch({ mode: 'cloud' });
    try { await clearCache(); } catch { patch({ warning: '기기 저장소 삭제를 완료하지 못했어요. 공유 기기라면 브라우저의 사이트 데이터를 삭제해 주세요.' }); }
    if (old) await google.revoke(old);
  });
}

async function selectDevice(id: string) {
  await action(async () => {
    if (!state.devices.some((d) => d.id === id)) throw new Error('이 계정에 연결된 PC를 선택해 주세요.');
    revision++; inFlight = null; current = null; base = null; pendingNonce = null;
    const ownRevision = revision;
    patch({ mode: 'cloud', selectedDeviceId: id, hasData: false, capturedAt: null, refreshRequestedAt: null }); changed();
    storageSet(LOCAL_MODE, null); storageSet(selectedKey(), id);
    const cached = await readCache(cacheKey(id));
    if (ownRevision !== revision) return;
    if (cached) installSnapshot(cached, 'cloud');
    await refresh();
  });
}

async function requestRefresh() {
  await action(async () => {
    if (isDesktop) { nativeStatus(await invoke<DesktopCloudStatus>('cloud_sync_now')); return; }
    const deviceId = state.selectedDeviceId;
    if (!account || state.mode !== 'cloud' || !deviceId) throw new Error('구글 드라이브에 연결한 뒤 PC를 선택해 주세요.');
    if (!hasToken()) { expire(); throw new google.AuthExpired(); }
    const ownRevision = revision;
    const nonce = google.newNonce();
    const name = requestName(deviceId);
    let file: google.DriveFile;
    try { file = await google.putProps(token!, driveFiles.requests.get(name)?.id ?? null, name, { tv: 'request', deviceId, nonce, at: String(Date.now()) }); }
    catch (error) { if (error instanceof google.AuthExpired) expire(); throw new Error('PC에 요청을 보내지 못했어요. 연결 상태를 확인해 주세요.'); }
    if (ownRevision !== revision) return;
    driveFiles.requests.set(name, file);
    pendingNonce = nonce;
    patch({ refreshRequestedAt: Date.now(), warning: null });
  });
}

async function importFile(file: File) {
  await action(async () => {
    if (file.size > MAX_SNAPSHOT_BYTES) throw new Error('JSON 파일은 8MB 이하만 불러올 수 있어요.');
    let data: unknown;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('JSON 파일을 읽을 수 없어요.'); }
    let value: CloudSnapshot;
    if (typeof data === 'object' && data && 'schemaVersion' in data) value = parseSnapshot(data);
    else {
      const legacy = data as Record<string, unknown> | null;
      const dashboard = parseDashboard(legacy?.get_dashboard ?? data);
      value = parseSnapshot({ schemaVersion: 1, device: { id: 'imported', name: file.name.slice(0, 100) || '가져온 기록' }, capturedAt: dashboard.now, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dashboard, pricing: legacy?.get_pricing ?? emptyPricing,
        settings: { ...DEFAULT_SETTINGS, ...(typeof legacy?.get_settings === 'object' ? legacy.get_settings : {}) }, live: {}, claudeHooked: dashboard.limits.some((l) => l.source === 'claude') });
    }
    revision++; base = null; pendingNonce = null; storageSet(LOCAL_MODE, 'import'); patch({ error: null, warning: null, lastFetchedAt: null, refreshRequestedAt: null });
    installSnapshot(value, 'import'); await storeSnapshot('local', value);
  });
}

export async function saveSharedSettings(settings: UiSettings) {
  const value = sharedSettings(settings);
  if (!current) throw new Error('데이터를 먼저 불러와 주세요.');
  if (state.mode === 'cloud') {
    if (!account || !navigator.onLine) throw new Error('공유 설정 저장에는 인터넷 연결과 구글 연결이 필요해요.');
    if (!hasToken()) { expire(); throw new google.AuthExpired(); }
    const ownRevision = revision;
    const props: Record<string, string> = { tv: 'settings', rev: String(Date.now()) };
    for (const key of SHARED_KEYS) props[key] = value[key] === null ? '' : String(value[key]);
    let file: google.DriveFile;
    try { file = await google.putProps(token!, driveFiles.settings?.id ?? null, SETTINGS_NAME, props); }
    catch (error) { if (error instanceof google.AuthExpired) expire(); throw new Error('설정을 저장하지 못했어요. 연결 상태를 확인해 주세요.'); }
    if (ownRevision !== revision) return;
    // Reads issued before this save may still carry the previous settings.
    revision++; inFlight = null;
    driveFiles.settings = { ...file, appProperties: props };
    if (!current) return;
    current = { ...current, settings: value };
    await storeSnapshot(cacheKey(current.device.id), current);
  } else { current = { ...current, settings: value }; await storeSnapshot('local', current); }
  changed();
  schedulePolling();
}

export const cloud = {
  initialize, signIn, signOut, selectDevice, importFile, requestRefresh,
  cancelSignIn: () => { if (isDesktop) void invoke('cloud_cancel_sign_in'); },
  configureDesktop: (config: DesktopConfiguration) => action(async () => {
    nativeStatus(await invoke<DesktopCloudStatus>('cloud_configure', { deviceName: config.deviceName.trim() || '내 PC', enabled: config.enabled, clientId: config.clientId.trim(), clientSecret: config.clientSecret.trim() }));
  }),
  setEnabled: (enabled: boolean) => cloud.configureDesktop({ deviceName: state.deviceName, enabled, clientId: state.clientId, clientSecret: '' }),
  setClientId: (id: string | null) => action(async () => {
    google.setClientId(id && id.trim() ? id : null);
    patch({ available: google.clientId() !== null, customClient: !!google.customClientId(), clientId: google.customClientId() ?? '' });
  }),
  refresh: () => action(async () => {
    if (!isDesktop && account && state.mode !== 'cloud') {
      revision++; inFlight = null; current = null; base = null; storageSet(LOCAL_MODE, null);
      patch({ mode: 'cloud', hasData: false, capturedAt: null, selectedDeviceId: storageGet(selectedKey()), refreshRequestedAt: null }); changed();
    }
    await refresh();
  }),
  syncNow: () => action(async () => { if (isDesktop) nativeStatus(await invoke<DesktopCloudStatus>('cloud_sync_now')); else await refresh(); }),
  loadDemo: () => action(async () => { revision++; base = null; const value = makeDemoSnapshot(); storageSet(LOCAL_MODE, 'demo'); patch({ error: null, warning: null, lastFetchedAt: null, refreshRequestedAt: null }); installSnapshot(value, 'demo'); await storeSnapshot('local', value); }),
  clearLocal: () => action(async () => { revision++; current = null; base = null; storageSet(LOCAL_MODE, null); await clearCache(); patch({ mode: 'cloud', hasData: false, capturedAt: null, lastFetchedAt: null, selectedDeviceId: null, refreshRequestedAt: null }); changed(); }),
  downloadSnapshot: async () => {
    if (!current) throw new Error('내보낼 데이터가 없어요.');
    const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `token-view-${state.mode}-${new Date(current.capturedAt).toISOString().slice(0, 10)}.json`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

export function useCloud() {
  const value = useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state);
  useEffect(() => { void initialize(); }, []);
  return value;
}
export function getCloudState() { return state; }
export function getSnapshot() { return current; }
export function onCloudData(cb: () => void) { dataListeners.add(cb); return () => { dataListeners.delete(cb); }; }
export function currentSharedSettings(): SharedSettings { return current?.settings ?? sharedSettings(DEFAULT_SETTINGS); }
