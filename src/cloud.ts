import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_SETTINGS, type UiSettings } from './cloud/models';
import type { CloudConfiguration, CloudSnapshot, CloudViewState, DesktopCloudStatus, SharedSettings } from './cloud/types';
import { MAX_SNAPSHOT_BYTES, parseDashboard, parseSnapshot, sharedSettings, validateConfiguration } from './cloud/schema';
import { clearCache, readCache, writeCache } from './cloud/cache';
import { emptyPricing, makeDemoSnapshot } from './cloud/demo';

export type { CloudViewState, CloudSnapshot } from './cloud/types';
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const CONFIG_KEY = 'tv-cloud-config-v1';
const LOCAL_MODE = 'tv-local-mode-v1';
const POLL_MS = 180_000;
let state: CloudViewState = {
  mode: isDesktop ? 'desktop' : 'cloud', initialized: false, configured: false, authenticated: false,
  email: null, url: '', anonKey: '', deviceName: '', enabled: false, persistentSession: false,
  devices: [], selectedDeviceId: null, busy: false, error: null, warning: null,
  offline: typeof navigator !== 'undefined' && !navigator.onLine,
  lastFetchedAt: null, capturedAt: null, lastUploadAt: null, refreshRequestedAt: null, hasData: false,
};
let current: CloudSnapshot | null = null;
let client: SupabaseClient | null = null;
let session: Session | null = null;
let initial: Promise<void> | null = null;
let revision = 0;
let inFlight: Promise<void> | null = null;
let lastAttempt = 0;
let failureCount = 0;
let authUnsubscribe: (() => void) | null = null;
let schedulePolling = () => {};
const listeners = new Set<() => void>();
const dataListeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
function patch(values: Partial<CloudViewState>) { state = { ...state, ...values }; notify(); schedulePolling(); }
function changed() { dataListeners.forEach((listener) => listener()); }
function storageGet(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key: string, value: string | null) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* session-only when browser storage is unavailable */ } }
const selectedKey = () => `tv-selected:${state.url}:${session?.user.id ?? ''}`;
const cacheKey = (deviceId: string) => `${state.url}|${session?.user.id}|${deviceId}`;
const message = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : '연결을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.';

async function action(task: () => Promise<void>) {
  patch({ busy: true, error: null });
  try { await task(); } catch (error) { patch({ error: message(error) }); throw error; }
  finally { patch({ busy: false }); }
}

function nativeStatus(value: DesktopCloudStatus) {
  patch({ configured: value.configured, enabled: value.enabled, url: value.url, anonKey: value.anonKey, deviceName: value.deviceName,
    authenticated: value.authenticated, email: value.email, lastUploadAt: value.lastUploadAt, error: value.lastError,
    persistentSession: value.persistentSession, mode: 'desktop' });
}

function configuration() {
  try {
    const saved = storageGet(CONFIG_KEY);
    if (saved) return validateConfiguration(JSON.parse(saved).url, JSON.parse(saved).anonKey, import.meta.env.DEV);
    if (import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY) return validateConfiguration(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, import.meta.env.DEV);
  } catch { patch({ error: '저장된 연결 설정이 올바르지 않아요. 프로젝트 주소와 공개 키를 다시 확인해 주세요.' }); }
  return null;
}

function createConnection(config: { url: string; anonKey: string }) {
  authUnsubscribe?.();
  client?.auth.stopAutoRefresh();
  client = createClient(config.url, config.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: `tv-auth:${config.url}` },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) }) },
  });
  const subscription = client.auth.onAuthStateChange((event, value) => {
    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && value) {
      // During startup, getSession can emit SIGNED_IN while session is still null.
      // That restores the same saved account; it must not erase its selected device/cache.
      if ((session && session.user.id !== value.user.id) || (!session && state.initialized)) {
        revision++; inFlight = null; current = null; session = value;
        patch({ authenticated: true, email: value.user.email ?? null, mode: 'cloud', hasData: false, devices: [], selectedDeviceId: null, capturedAt: null, lastFetchedAt: null, refreshRequestedAt: null });
        storageSet(LOCAL_MODE, null); changed();
        // A different tab can switch accounts. Invalidate the old account before any new read.
        void clearCache().catch(() => {});
        setTimeout(() => { void refresh().catch((error) => patch({ error: message(error) })); }, 0);
      } else if (event === 'TOKEN_REFRESHED') session = value;
    }
    if (event === 'SIGNED_OUT' && session) {
      session = null; revision++; current = null;
      patch({ authenticated: false, email: null, hasData: false, devices: [], selectedDeviceId: null, capturedAt: null, lastFetchedAt: null, refreshRequestedAt: null });
      void clearCache().catch(() => {}); changed();
    }
  });
  authUnsubscribe = () => subscription.data.subscription.unsubscribe();
  patch({ configured: true, url: config.url, anonKey: config.anonKey });
}

function installSnapshot(value: CloudSnapshot, mode: CloudViewState['mode'] = state.mode) {
  current = value;
  const expiredRequest = state.refreshRequestedAt && Date.now() - state.refreshRequestedAt > 10 * 60_000;
  patch({ hasData: true, capturedAt: value.capturedAt, mode, selectedDeviceId: value.device.id,
    ...(expiredRequest ? { refreshRequestedAt: null } : {}) });
  changed();
}

async function storeSnapshot(key: string, value: CloudSnapshot) {
  try { await writeCache(key, value); }
  catch { patch({ warning: '기기 저장소를 사용할 수 없어 오프라인 보관이 제한돼요.' }); }
}

async function fetchSnapshot() {
  if (!client || !session || state.mode !== 'cloud') return;
  if (!navigator.onLine) { patch({ offline: true }); return; }
  const connection = client;
  const ownRevision = revision;
  lastAttempt = Date.now();
  const { data: devices, error } = await connection.from('snapshots').select('device_id,device_name,captured_at,uploaded_at').order('captured_at', { ascending: false }).limit(100);
  if (ownRevision !== revision) return;
  if (error) { failureCount++; throw new Error('클라우드 데이터를 가져오지 못했어요. 로그인과 연결 설정을 확인해 주세요.'); }
  const parsedDevices = (devices ?? []).filter((d) => typeof d.device_id === 'string' && typeof d.device_name === 'string' && Number.isFinite(Date.parse(d.captured_at)) && Number.isFinite(Date.parse(d.uploaded_at))).map((d) => ({ id: d.device_id as string, name: d.device_name as string, capturedAt: Date.parse(d.captured_at), uploadedAt: Date.parse(d.uploaded_at) }));
  const selected = parsedDevices.find((d) => d.id === state.selectedDeviceId) ?? parsedDevices[0];
  patch({ devices: parsedDevices });
  if (!selected) {
    failureCount = 0;
    current = null;
    patch({ hasData: false, capturedAt: null, selectedDeviceId: null, lastFetchedAt: Date.now(), error: null });
    changed(); return;
  }
  // The server forbids changing a payload at the same capture time; avoid downloading it again.
  const unchanged = current?.device.id === selected.id && current.capturedAt === selected.capturedAt;
  const pendingRequest = state.refreshRequestedAt;
  const [{ data: row, error: snapshotError }, { data: settingsRow, error: settingsError }, requestResult] = await Promise.all([
    unchanged ? Promise.resolve({ data: { payload: current }, error: null }) : connection.from('snapshots').select('payload').eq('device_id', selected.id).single(),
    connection.from('user_settings').select('settings').maybeSingle(),
    pendingRequest ? connection.from('refresh_requests').select('requested_at,handled_at').eq('device_id', selected.id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  if (ownRevision !== revision) return;
  if (snapshotError || !row) { failureCount++; throw new Error('선택한 PC의 데이터를 가져오지 못했어요.'); }
  const value = parseSnapshot(row.payload);
  if (value.device.id !== selected.id) throw new Error('기기 정보가 일치하지 않아 데이터를 표시하지 않았어요.');
  if (settingsRow && !settingsError) value.settings = sharedSettings(settingsRow.settings);
  if (current?.device.id === value.device.id && current.capturedAt > value.capturedAt) {
    patch({ lastFetchedAt: Date.now(), warning: '클라우드에 더 오래된 기록이 있어 기기의 최신 기록을 유지했어요.' });
    return;
  }
  failureCount = 0;
  // PC capture times can differ from the server clock. Only its exact server acknowledgement completes a request.
  if (pendingRequest && state.refreshRequestedAt === pendingRequest && !requestResult.error && requestResult.data?.handled_at
    && Date.parse(requestResult.data.requested_at) === pendingRequest) patch({ refreshRequestedAt: null });
  storageSet(selectedKey(), value.device.id);
  patch({ lastFetchedAt: Date.now(), offline: false, error: null, warning: settingsError ? '공유 설정을 불러오지 못해 수집 당시 설정을 사용해요.' : null });
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

async function restoreSession() {
  if (!client) return;
  const ownRevision = revision;
  const { data, error } = await client.auth.getSession();
  if (ownRevision !== revision) return;
  if (error) throw new Error('로그인을 다시 해 주세요.');
  session = data.session;
  patch({ authenticated: !!session, email: session?.user.email ?? null });
  if (session && state.mode === 'cloud') {
    const deviceId = storageGet(selectedKey());
    if (deviceId) {
      patch({ selectedDeviceId: deviceId });
      const cached = await readCache(cacheKey(deviceId));
      if (ownRevision !== revision) return;
      if (cached) installSnapshot(cached, 'cloud');
    }
    await refresh();
  }
}

async function initialize() {
  if (initial) return initial;
  initial = (async () => {
    try {
      if (isDesktop) {
        nativeStatus(await invoke<DesktopCloudStatus>('cloud_status'));
        const { listen } = await import('@tauri-apps/api/event');
        await listen('cloud-status', () => { void refresh().catch(() => {}); });
      }
      else {
        const localMode = storageGet(LOCAL_MODE);
        if (localMode === 'import' || localMode === 'demo') {
          const cached = await readCache('local');
          if (cached) installSnapshot(cached, localMode);
        }
        const config = configuration();
        if (config) { createConnection(config); await restoreSession(); }
      }
    } catch (error) { patch({ error: message(error) }); }
    finally { patch({ initialized: true }); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const maybeRefresh = () => {
      patch({ offline: !navigator.onLine });
      if (state.refreshRequestedAt && Date.now() - state.refreshRequestedAt >= 10 * 60_000) patch({ refreshRequestedAt: null });
      if (document.visibilityState === 'hidden' || !navigator.onLine) return;
      void refresh().catch((error) => patch({ error: message(error) })).finally(schedulePolling);
    };
    schedulePolling = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden' || !navigator.onLine) return;
      if (!isDesktop && (!client || !session || state.mode !== 'cloud' || inFlight)) return;
      const interval = Math.min(POLL_MS * 2 ** Math.min(failureCount, 3), 15 * 60_000);
      // Anchor to the actual read, not page startup: a later sign-in must not miss the first 3-minute deadline.
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

async function configure(config: CloudConfiguration) {
  const validated = validateConfiguration(config.url, config.anonKey, import.meta.env.DEV);
  await action(async () => {
    if (isDesktop) {
      nativeStatus(await invoke<DesktopCloudStatus>('cloud_configure', { ...validated, deviceName: config.deviceName?.trim() || '내 PC', enabled: config.enabled ?? true }));
      return;
    }
    await signOutLocal();
    storageSet(CONFIG_KEY, JSON.stringify(validated));
    createConnection(validated);
  });
}

async function signOutLocal() {
  revision++; inFlight = null; current = null; session = null;
  storageSet(LOCAL_MODE, null);
  patch({ mode: 'cloud', authenticated: false, email: null, hasData: false, devices: [], selectedDeviceId: null, capturedAt: null, lastFetchedAt: null, refreshRequestedAt: null, warning: null });
  changed();
  try { await clearCache(); } catch { patch({ warning: '기기 저장소 삭제를 완료하지 못했어요. 공유 기기라면 브라우저의 사이트 데이터를 삭제해 주세요.' }); }
  if (client) {
    await client.auth.signOut({ scope: 'local' }).catch(() => {});
    storageSet(`tv-auth:${state.url}`, null);
  }
}

async function signIn(email: string, password: string) {
  await action(async () => {
    if (isDesktop) { nativeStatus(await invoke<DesktopCloudStatus>('cloud_sign_in', { email: email.trim(), password })); return; }
    if (!client) throw new Error('먼저 클라우드 연결을 설정해 주세요.');
    revision++; inFlight = null;
    current = null; storageSet(LOCAL_MODE, null); patch({ mode: 'cloud', hasData: false, capturedAt: null, selectedDeviceId: null }); changed();
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error || !data.session) throw new Error('로그인하지 못했어요. 이메일·비밀번호와 이메일 인증 여부를 확인해 주세요.');
    session = data.session; patch({ authenticated: true, email: session.user.email ?? null });
    await restoreSession();
  });
}

async function selectDevice(id: string) {
  await action(async () => {
    if (!state.devices.some((d) => d.id === id)) throw new Error('이 계정에 연결된 PC를 선택해 주세요.');
    revision++; inFlight = null; current = null;
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
    if (!client || !session || state.mode !== 'cloud' || !state.selectedDeviceId) throw new Error('클라우드에 로그인한 뒤 PC를 선택해 주세요.');
    const ownRevision = revision;
    const { data, error } = await client.rpc('request_refresh', { p_device_id: state.selectedDeviceId });
    if (ownRevision !== revision) return;
    if (error) throw new Error('PC에 조회 요청을 보내지 못했어요. 연결 상태를 확인해 주세요.');
    const row = Array.isArray(data) ? data[0] : data;
    const requestedAt = Date.parse(row?.requested_at);
    if (!Number.isFinite(requestedAt)) throw new Error('조회 요청 응답이 올바르지 않아요. 클라우드 스키마를 확인해 주세요.');
    patch({ refreshRequestedAt: row?.handled_at ? null : requestedAt,
      warning: row?.handled_at ? '최근 PC 요청이 이미 처리됐어요. 새로운 요청은 잠시 후 보낼 수 있어요.' : null });
    await refresh();
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
    revision++; storageSet(LOCAL_MODE, 'import'); patch({ error: null, warning: null, lastFetchedAt: null, refreshRequestedAt: null });
    installSnapshot(value, 'import'); await storeSnapshot('local', value);
  });
}

export async function saveSharedSettings(settings: UiSettings) {
  const value = sharedSettings(settings);
  if (!current) throw new Error('데이터를 먼저 불러와 주세요.');
  if (state.mode === 'cloud') {
    if (!client || !session || !navigator.onLine) throw new Error('공유 설정 저장에는 인터넷 연결과 로그인이 필요해요.');
    const ownRevision = revision;
    const { data, error } = await client.rpc('save_user_settings', { p_settings: value });
    if (ownRevision !== revision) return;
    if (error) throw new Error('설정을 저장하지 못했어요. 연결 상태를 확인해 주세요.');
    // Reads issued before this save may still contain the previous settings.
    revision++; inFlight = null;
    if (!current) return;
    const row = Array.isArray(data) ? data[0] : data;
    current = { ...current, settings: sharedSettings(row?.settings ?? value) };
    await storeSnapshot(cacheKey(current.device.id), current);
  } else { current = { ...current, settings: value }; await storeSnapshot('local', current); }
  changed();
  schedulePolling();
}

export const cloud = {
  initialize, configure, signIn,
  signOut: () => action(async () => { if (isDesktop) nativeStatus(await invoke<DesktopCloudStatus>('cloud_sign_out')); else await signOutLocal(); }),
  refresh: () => action(async () => {
    if (!isDesktop && session && state.mode !== 'cloud') {
      revision++; inFlight = null; current = null; storageSet(LOCAL_MODE, null);
      patch({ mode: 'cloud', hasData: false, capturedAt: null, selectedDeviceId: storageGet(selectedKey()), refreshRequestedAt: null }); changed();
    }
    await refresh();
  }), requestRefresh,
  syncNow: () => action(async () => { if (isDesktop) nativeStatus(await invoke<DesktopCloudStatus>('cloud_sync_now')); else await refresh(); }),
  selectDevice, importFile,
  loadDemo: () => action(async () => { revision++; const value = makeDemoSnapshot(); storageSet(LOCAL_MODE, 'demo'); patch({ error: null, warning: null, lastFetchedAt: null, refreshRequestedAt: null }); installSnapshot(value, 'demo'); await storeSnapshot('local', value); }),
  clearLocal: () => action(async () => { revision++; current = null; storageSet(LOCAL_MODE, null); await clearCache(); patch({ mode: 'cloud', hasData: false, capturedAt: null, lastFetchedAt: null, selectedDeviceId: null, refreshRequestedAt: null }); changed(); }),
  downloadSnapshot: async () => {
    if (!current) throw new Error('내보낼 데이터가 없어요.');
    const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `token-view-${state.mode}-${new Date(current.capturedAt).toISOString().slice(0, 10)}.json`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  setEnabled: (enabled: boolean) => configure({ url: state.url, anonKey: state.anonKey, deviceName: state.deviceName, enabled }),
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
