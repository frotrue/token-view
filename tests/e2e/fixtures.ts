import { expect, type BrowserContext, type Page } from '@playwright/test';
import { gzipSync } from 'node:zlib';
import type { CloudSnapshot, SharedSettings } from '../../src/cloud/types';

export const CLIENT_ID = 'fixture-client-0001.apps.googleusercontent.com';
export const DRIVE = 'https://www.googleapis.com';
export const USER_ID = '100000000000000000001';
export const PC_A = '20000000-0000-4000-8000-000000000001';
export const PC_B = '20000000-0000-4000-8000-000000000002';
export const EMAIL = 'beta@example.test';
export const settingsFixture: SharedSettings = {
  currency: 'USD', krwRate: 1400, monthlyBudget: 300, budgetClaude: 200, budgetCodex: 100,
};

// Deterministic test data is authored independently of the app's demo generator.
export function snapshotFixture({ now = Date.now(), id = PC_A, name = 'QA 작업 PC', cost = 12.5 } = {}): CloudSnapshot {
  const sums = { input: 10_000, cacheWrite: 1000, cacheRead: 20_000, output: 4000, reasoning: 2000, cost, requests: 5 };
  const date = new Date(now).toISOString().slice(0, 10);
  const daily = { ...sums, date, source: 'claude' as const };
  return {
    schemaVersion: 1, device: { id, name }, capturedAt: now, timezone: 'UTC',
    dashboard: {
      now, totals: [{ ...sums, source: 'claude', firstTs: now - 86_400_000, lastTs: now }],
      daily: [daily], dailyModel: [{ ...daily, model: 'claude-fixture-model' }],
      dailyProject: [{ ...daily, project: 'fixture-project-with-a-long-but-readable-label' }],
      hourly: [{ ...sums, source: 'claude', hour: Math.floor(now / 3_600_000) * 3_600_000 }],
      fine: [{ ...sums, source: 'claude', t: now - 60_000 }],
      limits: [{ source: 'claude', limitId: 'claude', win: 'five_hour', ts: now, usedPct: 42, windowMinutes: 300, resetsAt: now + 3_600_000, plan: 'Fixture' }],
      unpriced: [],
      sessions: [{ ...sums, source: 'claude', session: 'fixture-session', project: 'fixture-project', firstTs: now - 600_000, lastTs: now, models: 'claude-fixture-model' }],
    },
    pricing: {
      pricing: { version: 'fixture', entries: [], fast_mult: 1, web_search_usd: 0 },
      custom: false, defaultVersion: 'fixture', builtinVersion: 'fixture', remoteUrl: '',
    },
    settings: { ...settingsFixture }, live: {}, claudeHooked: true,
  };
}

export async function selectTab(page: Page, name: '개요' | '한도 · 예측' | '통계' | '설정') {
  await page.getByRole('button', { name, exact: true }).filter({ visible: true }).click();
}

export async function expectNoViewportOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({
    width: window.innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth,
    mainWidth: document.querySelector('main')?.clientWidth ?? 0,
    mainScroll: document.querySelector('main')?.scrollWidth ?? 0,
  }));
  expect(sizes.body, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.width + 1);
  expect(sizes.html, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.width + 1);
  expect(sizes.mainScroll, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.mainWidth + 1);
}

export async function importJson(page: Page, value: unknown, filename = 'fixture.json') {
  await page.getByLabel('Token View 스냅샷 JSON 가져오기').setInputFiles({
    name: filename, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)),
  });
}

export async function waitForOfflineShell(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
  });
}

export async function cacheRecordCount(page: Page) {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('token-view-private-v1', 1);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('snapshots')) { database.close(); resolve(0); return; }
      const count = database.transaction('snapshots').objectStore('snapshots').count();
      count.onsuccess = () => { resolve(count.result); database.close(); };
      count.onerror = () => { reject(count.error); database.close(); };
    };
    request.onerror = () => reject(request.error);
  }));
}

export interface MockDevice { snapshot: CloudSnapshot; checkedAt?: number; handled?: string }
export interface MockCloud {
  devices: Map<string, MockDevice>;
  settings: SharedSettings | null;
  requests: Map<string, Record<string, string>>;
  calls: { method: string; url: string; body: unknown }[];
  failList: boolean;
  unauthorized: boolean;
  invalidSnapshot: unknown | null;
  unexpected: string[];
}
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS' };

export const listCalls = (cloud: MockCloud) => cloud.calls.filter((c) => c.method === 'GET' && c.url.includes('/drive/v3/files?spaces=appDataFolder')).length;
export const downloadCalls = (cloud: MockCloud) => cloud.calls.filter((c) => c.url.includes('alt=media')).length;

// Google's endpoints are intercepted here: the OAuth redirect, userinfo and the Drive
// appDataFolder calls. This verifies the client, not a live Google project.
export async function mockCloud(target: Page | BrowserContext, now = Date.now()): Promise<MockCloud> {
  const cloud: MockCloud = {
    devices: new Map([
      [PC_A, { snapshot: snapshotFixture({ now: now - 20 * 60_000 }) }],
      [PC_B, { snapshot: snapshotFixture({ now: now - 30 * 60_000, id: PC_B, name: 'QA 보조 PC', cost: 81.75 }) }],
    ]),
    settings: { ...settingsFixture }, requests: new Map(), calls: [], failList: false, unauthorized: false, invalidSnapshot: null, unexpected: [],
  };
  let tokens = 0;
  await target.route('https://accounts.google.com/**', async (route) => {
    const url = new URL(route.request().url());
    const redirect = url.searchParams.get('redirect_uri')!;
    const hash = new URLSearchParams({
      access_token: `fixture-token-${++tokens}`, token_type: 'Bearer', expires_in: '3599',
      scope: 'email https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.appdata openid',
      state: url.searchParams.get('state') ?? '',
    });
    cloud.calls.push({ method: 'GET', url: url.toString(), body: null });
    await route.fulfill({ status: 302, headers: { location: `${redirect}#${hash}` } });
  });
  await target.route('https://oauth2.googleapis.com/**', (route) => route.fulfill({ status: 200, headers: cors, body: '' }));
  await target.route(`${DRIVE}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    const body = request.postDataJSON();
    cloud.calls.push({ method, url: url.toString(), body });
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(value) });
    if (cloud.unauthorized) { await json({ error: { code: 401 } }, 401); return; }
    if (url.pathname === '/oauth2/v3/userinfo') { await json({ sub: USER_ID, email: EMAIL, email_verified: true }); return; }
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      if (cloud.failList) { await json({ error: { message: 'Mock Drive temporarily unavailable' } }, 503); return; }
      const files: unknown[] = [];
      for (const [id, d] of cloud.devices) {
        const props: Record<string, string> = { tv: 'snapshot', schema: '1', enc: 'gzip', deviceId: id, deviceName: d.snapshot.device.name,
          capturedAt: String(d.snapshot.capturedAt), checkedAt: String(d.checkedAt ?? d.snapshot.capturedAt) };
        if (d.handled) props.handled = d.handled;
        files.push({ id: `snap-${id}`, name: `tv-snapshot-${id}`, modifiedTime: new Date(d.snapshot.capturedAt).toISOString(), appProperties: props });
      }
      if (cloud.settings) {
        const props: Record<string, string> = { tv: 'settings', rev: '1' };
        for (const [k, v] of Object.entries(cloud.settings)) props[k] = v === null ? '' : String(v);
        files.push({ id: 'settings-file', name: 'tv-settings', modifiedTime: new Date(now).toISOString(), appProperties: props });
      }
      for (const [name, props] of cloud.requests) files.push({ id: `req-${name}`, name, modifiedTime: new Date(now).toISOString(), appProperties: props });
      await json({ files }); return;
    }
    const media = /^\/drive\/v3\/files\/snap-(.+)$/.exec(url.pathname);
    if (media && method === 'GET' && url.searchParams.get('alt') === 'media') {
      const device = cloud.devices.get(media[1]);
      if (!device) { await json({ error: { code: 404 } }, 404); return; }
      const content = gzipSync(Buffer.from(JSON.stringify(cloud.invalidSnapshot ?? device.snapshot)));
      await route.fulfill({ status: 200, headers: cors, contentType: 'application/gzip', body: content }); return;
    }
    if (url.pathname.startsWith('/drive/v3/files') && (method === 'POST' || method === 'PATCH')) {
      const props = (body as { appProperties: Record<string, string> }).appProperties;
      if (props.tv === 'settings') {
        const num = (v: string) => v === '' ? null : Number(v);
        cloud.settings = { currency: props.currency as 'USD' | 'KRW', krwRate: Number(props.krwRate),
          monthlyBudget: num(props.monthlyBudget), budgetClaude: num(props.budgetClaude), budgetCodex: num(props.budgetCodex) };
        await json({ id: 'settings-file', name: 'tv-settings', modifiedTime: new Date().toISOString(), appProperties: props }); return;
      }
      if (props.tv === 'request') {
        const name = `tv-request-${props.deviceId}`;
        cloud.requests.set(name, props);
        await json({ id: `req-${name}`, name, modifiedTime: new Date().toISOString(), appProperties: props }); return;
      }
    }
    cloud.unexpected.push(`${method} ${url.pathname}`);
    await json({ error: { message: 'Unexpected mock API request' } }, 500);
  });
  return cloud;
}

/** Makes the build behave as if it shipped with a Google client id. */
export async function useClientId(target: Page | BrowserContext) {
  await target.addInitScript((id) => { if (!localStorage.getItem('tv-google-client-id')) localStorage.setItem('tv-google-client-id', id); }, CLIENT_ID);
}

export async function loginCloud(page: Page) {
  await page.getByRole('button', { name: '구글 계정으로 연결', exact: true }).click();
  await expect(page.getByRole('region', { name: '데이터 기준 시각' })).toContainText('QA 작업 PC');
  await expect(page.getByText('API 환산 누적 비용', { exact: true })).toBeVisible();
}
