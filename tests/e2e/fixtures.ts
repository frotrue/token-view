import { expect, type Page } from '@playwright/test';
import type { CloudSnapshot, SharedSettings } from '../../src/cloud/types';

export const MOCK_URL = 'https://beta-test.supabase.co';
export const MOCK_KEY = 'sb_publishable_browser_fixture_only';
export const USER_ID = '10000000-0000-4000-8000-000000000001';
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

export interface MockCloud {
  snapshots: Map<string, CloudSnapshot>;
  settings: SharedSettings;
  calls: { method: string; path: string; body: unknown; query: string }[];
  failSnapshots: boolean;
  invalidSnapshot: unknown | null;
  requestedAt: number | null;
  handledAt: number | null;
  unexpected: string[];
}

function jwt(payload: object) {
  return `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture_signature`;
}

// Every cloud response is intercepted here. This verifies client behavior, not live
// Supabase availability, database RLS, provider credentials, or PC publication.
export async function mockCloud(page: Page, now = Date.now()): Promise<MockCloud> {
  const cloud: MockCloud = {
    snapshots: new Map([
      [PC_A, snapshotFixture({ now: now - 20 * 60_000 })],
      [PC_B, snapshotFixture({ now: now - 30 * 60_000, id: PC_B, name: 'QA 보조 PC', cost: 81.75 })],
    ]),
    settings: { ...settingsFixture }, calls: [], failSnapshots: false, invalidSnapshot: null,
    requestedAt: null, handledAt: null, unexpected: [],
  };
  await page.route(`${MOCK_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON();
    cloud.calls.push({ method: request.method(), path: url.pathname, body, query: url.search });
    const respond = (value: unknown, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(value),
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    });
    if (request.method() === 'OPTIONS') { await respond(null); return; }
    if (url.pathname === '/auth/v1/token') {
      const exp = Math.floor(now / 1000) + 24 * 3600;
      await respond({
        access_token: jwt({ sub: USER_ID, role: 'authenticated', exp, email: EMAIL }), token_type: 'bearer', expires_in: 24 * 3600, expires_at: exp,
        refresh_token: 'fixture_refresh_token',
        user: { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: EMAIL, email_confirmed_at: new Date(now).toISOString(), app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: new Date(now).toISOString() },
      }); return;
    }
    if (url.pathname === '/auth/v1/logout') { await respond(null, 204); return; }
    if (url.pathname === '/rest/v1/snapshots') {
      if (cloud.failSnapshots) { await respond({ code: 'fixture_failure', message: 'Mock cloud temporarily unavailable' }, 503); return; }
      if (url.searchParams.get('select') === 'payload') {
        const id = url.searchParams.get('device_id')?.replace(/^eq\./, '') ?? PC_A;
        await respond({ payload: cloud.invalidSnapshot ?? cloud.snapshots.get(id) });
      } else {
        await respond([...cloud.snapshots.values()].sort((a, b) => b.capturedAt - a.capturedAt).map((snapshot) => ({
          device_id: snapshot.device.id, device_name: snapshot.device.name,
          captured_at: new Date(snapshot.capturedAt).toISOString(), uploaded_at: new Date(snapshot.capturedAt + 10_000).toISOString(),
        })));
      }
      return;
    }
    if (url.pathname === '/rest/v1/user_settings') { await respond({ settings: cloud.settings }); return; }
    if (url.pathname === '/rest/v1/refresh_requests') {
      await respond(cloud.requestedAt === null ? null : {
        requested_at: new Date(cloud.requestedAt).toISOString(),
        handled_at: cloud.handledAt === null ? null : new Date(cloud.handledAt).toISOString(),
      }); return;
    }
    if (url.pathname === '/rest/v1/rpc/save_user_settings') {
      cloud.settings = (body as { p_settings: SharedSettings }).p_settings;
      await respond([{ settings: cloud.settings }]); return;
    }
    if (url.pathname === '/rest/v1/rpc/request_refresh') {
      cloud.requestedAt = await page.evaluate(() => Date.now());
      cloud.handledAt = null;
      await respond([{ requested_at: new Date(cloud.requestedAt).toISOString() }]); return;
    }
    cloud.unexpected.push(`${request.method()} ${url.pathname}`);
    await respond({ message: 'Unexpected mock API request' }, 500);
  });
  return cloud;
}

export async function configureCloud(page: Page) {
  await page.locator('summary').filter({ hasText: '클라우드 연결 설정' }).click();
  await page.getByLabel('Supabase URL', { exact: true }).fill(MOCK_URL);
  await page.getByLabel('공개 anon / publishable key', { exact: true }).fill(MOCK_KEY);
  await page.getByRole('button', { name: '연결 설정 저장', exact: true }).click();
  await expect(page.getByLabel('클라우드 계정 이메일')).toBeVisible();
}

export async function loginCloud(page: Page) {
  await configureCloud(page);
  await page.getByLabel('클라우드 계정 이메일').fill(EMAIL);
  await page.getByLabel('비밀번호', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '로그인하고 기록 가져오기', exact: true }).click();
  await expect(page.getByRole('region', { name: '데이터 기준 시각' })).toContainText('QA 작업 PC');
  await expect(page.getByText('API 환산 누적 비용', { exact: true })).toBeVisible();
}
