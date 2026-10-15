import { test, expect } from '@playwright/test';
import {
  PC_A, PC_B, MOCK_URL, cacheRecordCount, expectNoViewportOverflow,
  importJson, loginCloud, mockCloud, selectTab, snapshotFixture, waitForOfflineShell,
} from './fixtures';

test('onboarding starts empty; explicit sample mode works across every tab', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('손안에서');
  await expect(page.getByText('누적 총 토큰', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('비밀번호', { exact: true })).toHaveCount(0);
  await expectNoViewportOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('onboarding.png'), fullPage: true });
  await page.getByRole('button', { name: '샘플 데이터 보기', exact: true }).click();
  const banner = page.getByRole('region', { name: '데이터 기준 시각' });
  await expect(banner).toContainText('샘플 데이터 · 실제 사용량이 아니에요');
  await expect(page.getByText('누적 총 토큰', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('overview-demo.png'), fullPage: true });
  for (const tab of ['한도 · 예측', '통계', '설정', '개요'] as const) {
    await selectTab(page, tab);
    await expectNoViewportOverflow(page);
    await expect(banner).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`tab-${tab === '한도 · 예측' ? 'limits' : tab === '통계' ? 'stats' : tab === '설정' ? 'settings' : 'overview'}.png`), fullPage: true });
    if (tab === '통계' || tab === '설정') {
      await page.locator('main').evaluate((main) => { main.scrollTop = main.scrollHeight; });
      await expectNoViewportOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`tab-${tab === '통계' ? 'stats' : 'settings'}-bottom.png`), fullPage: true });
      await page.locator('main').evaluate((main) => { main.scrollTop = 0; });
    }
  }
  await selectTab(page, '설정');
  await expect(page.getByText('로그 수집, 실시간 한도 조회 설정, Windows 알림·시작 프로그램, 단가 수정은 PC 앱에서 설정하세요.')).toBeVisible();
  await expect(page.getByRole('button', { name: '데이터베이스 다시 만들기' })).toHaveCount(0);
  await expect(page.getByLabel(/provider|Claude.*token|OpenAI.*token/i)).toHaveCount(0);
});

test('versioned JSON imports and downloads; malformed, future and oversized files preserve the last valid snapshot', async ({ page }) => {
  await page.goto('/');
  const snapshot = snapshotFixture();
  await importJson(page, snapshot);
  await expect(page.getByRole('region', { name: '데이터 기준 시각' })).toContainText('가져온 JSON 스냅샷');
  await expect(page.getByText('API 환산 누적 비용', { exact: true })).toBeVisible();
  await selectTab(page, '설정');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON 다운로드', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^token-view-import-.*\.json$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(snapshot);
  await importJson(page, { ...snapshot, schemaVersion: 999 });
  await expect(page.locator('.cloud-panel').getByRole('alert')).toContainText('지원하지 않거나 손상된 데이터');
  await importJson(page, { ...snapshot, capturedAt: Date.now() + 10 * 60_000 });
  await expect(page.locator('.cloud-panel').getByRole('alert')).toContainText('미래로');
  await page.getByLabel('Token View 스냅샷 JSON 가져오기').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(page.locator('.cloud-panel').getByRole('alert')).toContainText('JSON 파일을 읽을 수 없어요');
  await page.getByLabel('Token View 스냅샷 JSON 가져오기').setInputFiles({ name: 'oversized.json', mimeType: 'application/json', buffer: Buffer.alloc(8 * 1024 * 1024 + 1, 32) });
  await expect(page.locator('.cloud-panel').getByRole('alert')).toContainText('8MB 이하');
  await expect.poll(() => cacheRecordCount(page)).toBe(1);
  await selectTab(page, '개요');
  await expect(page.getByText('$12.50', { exact: true }).first()).toBeVisible();
  await expectNoViewportOverflow(page);
});

test('legacy dashboard export remains importable without a cloud backend', async ({ page }) => {
  await page.goto('/');
  const snapshot = snapshotFixture();
  await importJson(page, { get_dashboard: snapshot.dashboard, get_settings: snapshot.settings, get_pricing: snapshot.pricing });
  await expect(page.getByText('API 환산 누적 비용', { exact: true })).toBeVisible();
  await expect(page.getByText('$12.50', { exact: true }).first()).toBeVisible();
});

test('daily usage and month totals use the PC calendar across viewer timezone boundaries', async ({ page }) => {
  await page.goto('/');
  const snapshot = snapshotFixture({ now: Date.UTC(2026, 8, 30, 16) });
  snapshot.timezone = 'Asia/Seoul'; // October 1 in Seoul, September 30 in the UTC viewer.
  for (const rows of [snapshot.dashboard.daily, snapshot.dashboard.dailyModel, snapshot.dashboard.dailyProject]) {
    for (const row of rows) row.date = '2026-10-01';
  }
  await importJson(page, snapshot);
  await expect(page.getByRole('region', { name: '데이터 기준 시각' })).toContainText('Asia/Seoul · PC 시간대');
  await expect(page.getByText('10월 · 캡처 기준 (API 환산)', { exact: true })).toBeVisible();
  const capturedDay = page.locator('.kpi').filter({ hasText: '캡처 당일' });
  await expect(capturedDay).toContainText('$12.50');
  await selectTab(page, '통계');
  await page.getByRole('radio', { name: '오늘', exact: true }).click();
  await expect(page.getByText('claude-fixture-model', { exact: true }).first()).toBeVisible();
  await expectNoViewportOverflow(page);
});

test('the built service worker reloads imported data offline and retains local budget settings', async ({ page, context }) => {
  await page.goto('/');
  await waitForOfflineShell(page);
  await importJson(page, snapshotFixture());
  await selectTab(page, '설정');
  await page.getByLabel('월 예산 · 전체 (USD)', { exact: true }).fill('432');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('설정을 저장했어요');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('region', { name: '데이터 기준 시각' })).toContainText('오프라인 · 저장된 기록');
  await expect(page.getByText('$12.50', { exact: true }).first()).toBeVisible();
  await selectTab(page, '설정');
  await expect(page.getByLabel('월 예산 · 전체 (USD)', { exact: true })).toHaveValue('432');
  const cachedUrls = await page.evaluate(async () => {
    const entries = await Promise.all((await caches.keys()).map(async (key) => (await (await caches.open(key)).keys()).map((request) => request.url)));
    return entries.flat();
  });
  expect(cachedUrls.some((url) => url.endsWith('/index.html'))).toBe(true);
  expect(cachedUrls.some((url) => /supabase|snapshot|\.json(?:\?|$)/.test(url))).toBe(false);
  await expectNoViewportOverflow(page);
});

test('local data deletion requires confirmation and survives reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '샘플 데이터 보기', exact: true }).click();
  await selectTab(page, '설정');
  await page.getByRole('button', { name: '이 기기의 저장 데이터 지우기', exact: true }).click();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect.poll(() => cacheRecordCount(page)).toBe(1);
  await page.getByRole('button', { name: '이 기기의 저장 데이터 지우기', exact: true }).click();
  await page.getByRole('button', { name: '저장 데이터 지우기', exact: true }).click();
  await expect.poll(() => cacheRecordCount(page)).toBe(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('손안에서');
  await expect(page.getByText('누적 총 토큰', { exact: true })).toHaveCount(0);
});

test('cloud configuration rejects administrator keys and insecure URLs', async ({ page }) => {
  await page.goto('/');
  await page.locator('summary').filter({ hasText: '클라우드 연결 설정' }).click();
  await page.getByLabel('Supabase URL', { exact: true }).fill(MOCK_URL);
  const privilegedKey = `fixture.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.fixture`;
  await page.getByLabel('공개 anon / publishable key', { exact: true }).fill(privilegedKey);
  await page.getByRole('button', { name: '연결 설정 저장', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('secret/service_role');
  await page.getByLabel('공개 anon / publishable key', { exact: true }).fill('sb_publishable_fixture');
  await page.getByLabel('Supabase URL', { exact: true }).fill('http://example.test');
  await page.getByRole('button', { name: '연결 설정 저장', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('HTTPS 프로젝트 주소');
  expect(await page.evaluate(() => localStorage.getItem('tv-cloud-config-v1'))).toBeNull();
});

test.describe('mocked Supabase client workflows (no live backend verification)', () => {
  test('password sign-in, independent PC selection and shared display settings', async ({ page }) => {
    const backend = await mockCloud(page);
    await page.goto('/');
    await loginCloud(page);
    await expect(page.getByText('$12.50', { exact: true }).first()).toBeVisible();
    await selectTab(page, '설정');
    await page.getByLabel('보고 있는 PC', { exact: true }).selectOption(PC_B);
    await selectTab(page, '개요');
    await expect(page.getByRole('region', { name: '데이터 기준 시각' })).toContainText('QA 보조 PC');
    await expect(page.getByText('$81.75', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('$94.25', { exact: true })).toHaveCount(0);
    await selectTab(page, '설정');
    await page.getByRole('radio', { name: '원화 (₩)', exact: true }).click();
    await page.getByLabel('환율 (₩/$)', { exact: true }).fill('1500');
    await page.getByLabel('월 예산 · 전체 (USD)', { exact: true }).fill('456');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('설정을 저장했어요');
    expect(backend.settings).toEqual({ currency: 'KRW', krwRate: 1500, monthlyBudget: 456, budgetClaude: 200, budgetCodex: 100 });
    const saved = backend.calls.find((call) => call.path.endsWith('/save_user_settings'))!;
    expect(Object.keys((saved.body as { p_settings: object }).p_settings).sort()).toEqual(['budgetClaude', 'budgetCodex', 'currency', 'krwRate', 'monthlyBudget']);
    await page.reload();
    await expect(page.getByRole('region', { name: '데이터 기준 시각' })).toContainText('QA 보조 PC');
    await selectTab(page, '설정');
    await expect(page.getByLabel('월 예산 · 전체 (USD)', { exact: true })).toHaveValue('456');
    await expect(page.getByLabel('환율 (₩/$)', { exact: true })).toHaveValue('1500');
    expect(backend.unexpected).toEqual([]);
    await expectNoViewportOverflow(page);
  });

  test('stale capture stays visible during errors; PC request remains pending until server acknowledgement', async ({ page }, testInfo) => {
    const backend = await mockCloud(page);
    await page.goto('/');
    await loginCloud(page);
    const banner = page.getByRole('region', { name: '데이터 기준 시각' });
    await expect(banner).toContainText('오래된 캡처예요');
    await expect(banner).toContainText('PC 캡처');
    await expect(banner).toContainText('이 기기에서 가져옴');
    await banner.getByRole('button', { name: 'PC에 최신 한도 요청', exact: true }).click();
    await expect(banner.getByRole('status')).toContainText('PC가 실행 중이고 온라인이면');
    expect(backend.calls.find((call) => call.path.endsWith('/request_refresh'))?.body).toEqual({ p_device_id: PC_A });
    await page.screenshot({ path: testInfo.outputPath('cloud-stale-pending.png'), fullPage: true });
    backend.failSnapshots = true;
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(banner.getByRole('alert')).toContainText('클라우드 데이터를 가져오지 못했어요');
    await expect(page.getByText('$12.50', { exact: true }).first()).toBeVisible();
    await expect(banner.getByRole('status')).toBeVisible();
    backend.failSnapshots = false;
    backend.snapshots.set(PC_A, snapshotFixture({ now: backend.requestedAt!, cost: 19.5 }));
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(page.getByText('$19.50', { exact: true }).first()).toBeVisible();
    await expect(banner.getByRole('status')).toBeVisible();
    backend.handledAt = backend.requestedAt;
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(banner.getByRole('status')).toHaveCount(0);
    await expect(banner).not.toContainText('오래된 캡처예요');
    expect(backend.unexpected).toEqual([]);
  });

  test('a PC clock ahead of the viewer cannot fulfil a refresh request; only the matching server acknowledgement can', async ({ page }) => {
    const now = Date.now();
    const backend = await mockCloud(page, now);
    backend.snapshots.set(PC_A, snapshotFixture({ now: now + 120_000 }));
    await page.goto('/');
    await loginCloud(page);
    const banner = page.getByRole('region', { name: '데이터 기준 시각' });
    await banner.getByRole('button', { name: 'PC에 최신 한도 요청', exact: true }).click();
    await expect(banner.getByRole('status')).toBeVisible();
    const requestedAt = backend.requestedAt!;
    // An acknowledgement of a different request cannot clear the newer pending one.
    backend.requestedAt = requestedAt - 60_000;
    backend.handledAt = requestedAt;
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(banner.getByRole('status')).toBeVisible();
    backend.requestedAt = requestedAt;
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(banner.getByRole('status')).toHaveCount(0);
    expect(backend.unexpected).toEqual([]);
  });

  test('a delayed old settings read cannot overwrite a successful budget save or its offline cache', async ({ page, context }) => {
    const backend = await mockCloud(page);
    await page.goto('/');
    await waitForOfflineShell(page);
    await loginCloud(page);
    const oldSettings = { ...backend.settings };
    let readHeld = false;
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    await page.route(`${MOCK_URL}/rest/v1/user_settings?**`, async (route) => {
      if (!readHeld) {
        readHeld = true;
        await gate;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ settings: oldSettings }) });
      } else await route.fallback();
    });
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect.poll(() => readHeld).toBe(true);
    await selectTab(page, '설정');
    await page.getByLabel('월 예산 · 전체 (USD)', { exact: true }).fill('456');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('설정을 저장했어요');
    expect(backend.settings.monthlyBudget).toBe(456);
    const lateRead = page.waitForResponse((response) => response.url().startsWith(`${MOCK_URL}/rest/v1/user_settings?`));
    releaseRead();
    await lateRead;
    await expect(page.locator('.cloud-panel').getByRole('button', { name: '클라우드 새로고침', exact: true })).toBeEnabled();
    await expect(page.getByLabel('월 예산 · 전체 (USD)', { exact: true })).toHaveValue('456');
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('region', { name: '데이터 기준 시각' })).toContainText('오프라인 · 저장된 기록');
    await selectTab(page, '설정');
    await expect(page.getByLabel('월 예산 · 전체 (USD)', { exact: true })).toHaveValue('456');
    expect(backend.unexpected).toEqual([]);
  });

  test('invalid cloud payload cannot replace the previous validated record', async ({ page }) => {
    const backend = await mockCloud(page);
    await page.goto('/');
    await loginCloud(page);
    backend.invalidSnapshot = { schemaVersion: 1, device: { id: PC_A, name: 'broken' } };
    // A new remote capture must be downloaded; unchanged captures use validated cache.
    backend.snapshots.set(PC_A, snapshotFixture({ now: Date.now() }));
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(page.getByRole('region', { name: '데이터 기준 시각' }).getByRole('alert')).toContainText('지원하지 않거나 손상된 데이터');
    await expect(page.getByText('$12.50', { exact: true }).first()).toBeVisible();
    await expect.poll(() => cacheRecordCount(page)).toBe(1);
  });

  test('cloud cache works on offline reload; sign-out clears both PC caches and auth session', async ({ page, context }) => {
    const backend = await mockCloud(page);
    await page.goto('/');
    await waitForOfflineShell(page);
    await loginCloud(page);
    await selectTab(page, '설정');
    await page.getByLabel('보고 있는 PC', { exact: true }).selectOption(PC_B);
    await expect.poll(() => cacheRecordCount(page)).toBe(2);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('region', { name: '데이터 기준 시각' })).toContainText('오프라인 · 저장된 기록');
    await expect(page.getByText('$81.75', { exact: true }).first()).toBeVisible();
    await selectTab(page, '설정');
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await expect.poll(() => cacheRecordCount(page)).toBe(0);
    await expect(page.getByLabel('월 예산 · 전체 (USD)', { exact: true })).toHaveValue('');
    expect(await page.evaluate((url) => localStorage.getItem(`tv-auth:${url}`), MOCK_URL)).toBeNull();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('손안에서');
    await expect(page.getByText('누적 총 토큰', { exact: true })).toHaveCount(0);
    expect(backend.unexpected).toEqual([]);
  });

  test('sign-out in another tab cancels a delayed snapshot response without restoring private records', async ({ page, context }) => {
    const backend = await mockCloud(page);
    await page.goto('/');
    await loginCloud(page);
    const secondTab = await context.newPage();
    await mockCloud(secondTab);
    await secondTab.goto('/');
    await expect(secondTab.getByText('API 환산 누적 비용', { exact: true })).toBeVisible();
    backend.snapshots.set(PC_A, snapshotFixture({ now: Date.now(), cost: 19.5 }));
    let responseHeld = false;
    let releaseResponse!: () => void;
    const gate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    await page.route(`${MOCK_URL}/rest/v1/snapshots?**`, async (route) => {
      if (new URL(route.request().url()).searchParams.get('select') === 'payload' && !responseHeld) {
        responseHeld = true;
        await gate;
      }
      await route.fallback();
    });
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect.poll(() => responseHeld).toBe(true);
    await selectTab(secondTab, '설정');
    await secondTab.getByRole('button', { name: '로그아웃', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('손안에서');
    const lateResponse = page.waitForResponse((response) => response.url().startsWith(`${MOCK_URL}/rest/v1/snapshots?`) && new URL(response.url()).searchParams.get('select') === 'payload');
    releaseResponse();
    await lateResponse;
    await expect(page.getByRole('button', { name: '가져오기', exact: true })).toBeDisabled();
    await expect.poll(() => cacheRecordCount(page)).toBe(0);
    await expect(page.getByText('누적 총 토큰', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('누적 총 토큰', { exact: true })).toHaveCount(0);
    expect(backend.unexpected).toEqual([]);
    await secondTab.close();
  });

  test('180 second polling pauses when hidden or offline and resumes on return', async ({ page, context }) => {
    const now = Date.now();
    await page.clock.install({ time: now });
    const backend = await mockCloud(page, now);
    await page.goto('/');
    await loginCloud(page);
    const listCalls = () => backend.calls.filter((call) => call.path === '/rest/v1/snapshots' && call.query.includes('device_name')).length;
    const baseline = listCalls();
    await page.clock.runFor(179_000);
    expect(listCalls()).toBe(baseline);
    await page.clock.runFor(1000);
    await expect.poll(listCalls).toBe(baseline + 1);
    // Chromium's single page remains visible in headless mode, so emit the browser
    // visibility event with a synthetic hidden state while advancing actual timers.
    await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }));
    const hiddenBaseline = listCalls();
    await page.clock.runFor(180_000);
    expect(listCalls()).toBe(hiddenBaseline);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(listCalls).toBe(hiddenBaseline + 1);
    await context.setOffline(true);
    const offlineBaseline = listCalls();
    await page.clock.runFor(180_000);
    expect(listCalls()).toBe(offlineBaseline);
    await context.setOffline(false);
    await expect.poll(listCalls).toBe(offlineBaseline + 1);
    expect(backend.unexpected).toEqual([]);
  });
});
