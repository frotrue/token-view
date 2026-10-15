import { test, expect } from '@playwright/test';
import {
  CLIENT_ID, DRIVE, EMAIL, PAT, PC_A, PC_B, REPO, cacheRecordCount, connectGithub, downloadCalls, expectNoViewportOverflow,
  importJson, listCalls, loginCloud, mockCloud, mockGithub, selectTab, snapshotFixture, useClientId, waitForOfflineShell,
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
  expect(cachedUrls.some((url) => /googleapis|snapshot|\.json(?:\?|$)/.test(url))).toBe(false);
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

test('Google client id configuration rejects anything but an OAuth client id', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('이 빌드에는 구글 클라이언트 ID가 없어요')).toBeVisible();
  await expect(page.getByRole('button', { name: '구글 계정으로 연결', exact: true })).toHaveCount(0);
  await page.locator('summary').filter({ hasText: '구글 클라이언트 ID' }).click();
  await page.getByLabel('클라이언트 ID', { exact: true }).fill('https://evil.example');
  await page.getByRole('button', { name: '클라이언트 ID 저장', exact: true }).click();
  await expect(page.locator('.cloud-panel').getByRole('alert')).toContainText('apps.googleusercontent.com');
  expect(await page.evaluate(() => localStorage.getItem('tv-google-client-id'))).toBeNull();
  await page.getByLabel('클라이언트 ID', { exact: true }).fill(CLIENT_ID);
  await page.getByRole('button', { name: '클라이언트 ID 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '구글 계정으로 연결', exact: true })).toBeVisible();
});

test.describe('mocked Google Drive workflows (no live Google project)', () => {
  test.beforeEach(async ({ page }) => { await useClientId(page); });

  test('Google sign-in, independent PC selection and shared display settings', async ({ page }) => {
    const backend = await mockCloud(page);
    await page.goto('/');
    await loginCloud(page);
    const auth = backend.calls.find((call) => call.url.startsWith('https://accounts.google.com/'))!;
    const query = new URL(auth.url).searchParams;
    expect(query.get('response_type')).toBe('token');
    expect(query.get('scope')).toContain('auth/drive.appdata');
    expect(query.get('client_id')).toBe(CLIENT_ID);
    expect(await page.evaluate(() => location.hash)).toBe('');
    await expect(page.getByText('$12.50', { exact: true }).first()).toBeVisible();
    await selectTab(page, '설정');
    await expect(page.locator('.cloud-panel')).toContainText(EMAIL);
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
    const saved = backend.calls.find((call) => (call.body as { appProperties?: { tv?: string } } | null)?.appProperties?.tv === 'settings')!;
    expect(Object.keys((saved.body as { appProperties: object }).appProperties).sort()).toEqual(['budgetClaude', 'budgetCodex', 'currency', 'krwRate', 'monthlyBudget', 'rev', 'tv']);
    await page.reload();
    await expect(page.getByRole('region', { name: '데이터 기준 시각' })).toContainText('QA 보조 PC');
    await selectTab(page, '설정');
    await expect(page.getByLabel('월 예산 · 전체 (USD)', { exact: true })).toHaveValue('456');
    await expect(page.getByLabel('환율 (₩/$)', { exact: true })).toHaveValue('1500');
    expect(backend.unexpected).toEqual([]);
    await expectNoViewportOverflow(page);
  });

  test('stale capture stays visible during errors; a PC request stays pending until the PC marks it handled', async ({ page }, testInfo) => {
    const backend = await mockCloud(page);
    await page.goto('/');
    await loginCloud(page);
    const banner = page.getByRole('region', { name: '데이터 기준 시각' });
    await expect(banner).toContainText('오래된 캡처예요');
    await expect(banner).toContainText('PC 캡처');
    await expect(banner).toContainText('이 기기에서 가져옴');
    await banner.getByRole('button', { name: 'PC에 최신 한도 요청', exact: true }).click();
    await expect(banner.getByRole('status')).toContainText('PC가 실행 중이고 온라인이면');
    const request = backend.requests.get(`tv-request-${PC_A}`)!;
    expect(request.tv).toBe('request');
    expect(request.nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    await page.screenshot({ path: testInfo.outputPath('cloud-stale-pending.png'), fullPage: true });
    backend.failList = true;
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(banner.getByRole('alert')).toContainText('구글 드라이브에서 기록을 가져오지 못했어요');
    await expect(page.getByText('$12.50', { exact: true }).first()).toBeVisible();
    await expect(banner.getByRole('status')).toBeVisible();
    backend.failList = false;
    // A new capture that has not served this request leaves it pending.
    backend.devices.set(PC_A, { snapshot: snapshotFixture({ now: Date.now(), cost: 19.5 }), handled: 'some-older-request' });
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(page.getByText('$19.50', { exact: true }).first()).toBeVisible();
    await expect(banner.getByRole('status')).toBeVisible();
    backend.devices.get(PC_A)!.handled = request.nonce;
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(banner.getByRole('status')).toHaveCount(0);
    await expect(banner).not.toContainText('오래된 캡처예요');
    expect(backend.unexpected).toEqual([]);
  });

  test('an unchanged PC only advances its check time, which refreshes the capture without a download', async ({ page }) => {
    const backend = await mockCloud(page);
    await page.goto('/');
    await loginCloud(page);
    const banner = page.getByRole('region', { name: '데이터 기준 시각' });
    await expect(banner).toContainText('오래된 캡처예요');
    const downloads = downloadCalls(backend);
    backend.devices.get(PC_A)!.checkedAt = Date.now() - 30_000;
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(banner).not.toContainText('오래된 캡처예요');
    expect(downloadCalls(backend)).toBe(downloads);
    await expect(page.getByText('$12.50', { exact: true }).first()).toBeVisible();
  });

  test('an expired Google token keeps the data and offers a one-tap reconnect', async ({ page }) => {
    const backend = await mockCloud(page);
    await page.goto('/');
    await loginCloud(page);
    backend.unauthorized = true;
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    const banner = page.getByRole('region', { name: '데이터 기준 시각' });
    await expect(banner.getByRole('button', { name: '구글 다시 연결', exact: true })).toBeVisible();
    await expect(page.getByText('$12.50', { exact: true }).first()).toBeVisible();
    backend.unauthorized = false;
    await banner.getByRole('button', { name: '구글 다시 연결', exact: true }).click();
    await expect(banner.getByRole('button', { name: 'PC에 최신 한도 요청', exact: true })).toBeVisible();
    const reauth = backend.calls.filter((call) => call.url.startsWith('https://accounts.google.com/')).at(-1)!;
    expect(new URL(reauth.url).searchParams.get('login_hint')).toBe(EMAIL);
    expect(backend.unexpected).toEqual([]);
  });

  test('a delayed old read cannot overwrite a successful budget save or its offline cache', async ({ page, context }) => {
    const backend = await mockCloud(page);
    await page.goto('/');
    await waitForOfflineShell(page);
    await loginCloud(page);
    const oldSettings = { ...backend.settings! };
    let readHeld = false;
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    await page.route(`${DRIVE}/drive/v3/files?spaces=**`, async (route) => {
      if (!readHeld) {
        readHeld = true;
        const props: Record<string, string> = { tv: 'settings', rev: '0' };
        for (const [k, v] of Object.entries(oldSettings)) props[k] = v === null ? '' : String(v);
        await gate;
        await route.fulfill({ headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ files: [
          { id: `snap-${PC_A}`, name: `tv-snapshot-${PC_A}`, modifiedTime: '', appProperties: { tv: 'snapshot', deviceId: PC_A, deviceName: 'QA 작업 PC', capturedAt: String(backend.devices.get(PC_A)!.snapshot.capturedAt) } },
          { id: 'settings-file', name: 'tv-settings', modifiedTime: '', appProperties: props },
        ] }) });
      } else await route.fallback();
    });
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect.poll(() => readHeld).toBe(true);
    await selectTab(page, '설정');
    await page.getByLabel('월 예산 · 전체 (USD)', { exact: true }).fill('456');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('설정을 저장했어요');
    expect(backend.settings!.monthlyBudget).toBe(456);
    const lateRead = page.waitForResponse((response) => response.url().includes('/drive/v3/files?spaces='));
    releaseRead();
    await lateRead;
    await expect(page.locator('.cloud-panel').getByRole('button', { name: '기록 새로고침', exact: true })).toBeEnabled();
    await expect(page.getByLabel('월 예산 · 전체 (USD)', { exact: true })).toHaveValue('456');
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('region', { name: '데이터 기준 시각' })).toContainText('오프라인 · 저장된 기록');
    await selectTab(page, '설정');
    await expect(page.getByLabel('월 예산 · 전체 (USD)', { exact: true })).toHaveValue('456');
    expect(backend.unexpected).toEqual([]);
  });

  test('invalid Drive content cannot replace the previous validated record', async ({ page }) => {
    const backend = await mockCloud(page);
    await page.goto('/');
    await loginCloud(page);
    backend.invalidSnapshot = { schemaVersion: 1, device: { id: PC_A, name: 'broken' } };
    // A new capture must be downloaded; an unchanged capture reuses the validated copy.
    backend.devices.set(PC_A, { snapshot: snapshotFixture({ now: Date.now() }) });
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(page.getByRole('region', { name: '데이터 기준 시각' }).getByRole('alert')).toContainText('지원하지 않거나 손상된 데이터');
    await expect(page.getByText('$12.50', { exact: true }).first()).toBeVisible();
    await expect.poll(() => cacheRecordCount(page)).toBe(1);
  });

  test('Drive cache works on offline reload; disconnecting clears both PC caches and the token', async ({ page, context }) => {
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
    await page.getByRole('button', { name: '연결 해제', exact: true }).click();
    await expect.poll(() => cacheRecordCount(page)).toBe(0);
    await expect(page.getByLabel('월 예산 · 전체 (USD)', { exact: true })).toHaveValue('');
    expect(await page.evaluate(() => [localStorage.getItem('tv-google-token-v1'), localStorage.getItem('tv-google-account-v1')])).toEqual([null, null]);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('손안에서');
    await expect(page.getByText('누적 총 토큰', { exact: true })).toHaveCount(0);
    expect(backend.unexpected).toEqual([]);
  });

  test('disconnecting in another tab cancels a delayed download without restoring private records', async ({ page, context }) => {
    const backend = await mockCloud(context);
    await useClientId(context);
    await page.goto('/');
    await loginCloud(page);
    const secondTab = await context.newPage();
    await secondTab.goto('/');
    await expect(secondTab.getByText('API 환산 누적 비용', { exact: true })).toBeVisible();
    backend.devices.set(PC_A, { snapshot: snapshotFixture({ now: Date.now(), cost: 19.5 }) });
    let responseHeld = false;
    let releaseResponse!: () => void;
    const gate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    await page.route(`${DRIVE}/drive/v3/files/snap-**`, async (route) => {
      if (!responseHeld) { responseHeld = true; await gate; }
      await route.fallback();
    });
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect.poll(() => responseHeld).toBe(true);
    await selectTab(secondTab, '설정');
    await secondTab.getByRole('button', { name: '연결 해제', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('손안에서');
    const lateResponse = page.waitForResponse((response) => response.url().includes('alt=media'));
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
    const calls = () => listCalls(backend);
    const baseline = calls();
    await page.clock.runFor(179_000);
    expect(calls()).toBe(baseline);
    await page.clock.runFor(1000);
    await expect.poll(calls).toBe(baseline + 1);
    // Chromium's single page remains visible in headless mode, so emit the browser
    // visibility event with a synthetic hidden state while advancing actual timers.
    await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }));
    const hiddenBaseline = calls();
    await page.clock.runFor(180_000);
    expect(calls()).toBe(hiddenBaseline);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(calls).toBe(hiddenBaseline + 1);
    await context.setOffline(true);
    const offlineBaseline = calls();
    await page.clock.runFor(180_000);
    expect(calls()).toBe(offlineBaseline);
    await context.setOffline(false);
    await expect.poll(calls).toBe(offlineBaseline + 1);
    expect(backend.unexpected).toEqual([]);
  });
});

test.describe('mocked private GitHub repository workflows (no live GitHub)', () => {
  test('connect with a fine-grained token, read the PC snapshot, request a refresh and share settings', async ({ page }) => {
    const gh = await mockGithub(page);
    await page.goto('/');
    await connectGithub(page);
    const banner = page.getByRole('region', { name: '데이터 기준 시각' });
    await expect(banner).toContainText('QA 작업 PC');
    await expect(page.getByText('$12.50', { exact: true }).first()).toBeVisible();
    expect(gh.calls.every((call) => call.auth === `Bearer ${PAT}`)).toBe(true);
    await banner.getByRole('button', { name: 'PC에 최신 한도 요청', exact: true }).click();
    await expect(banner.getByRole('status')).toBeVisible();
    const request = gh.requests.get(`tv-request-${PC_A}`)!;
    expect(request.tv).toBe('request');
    // The PC serves the request: its snapshot branch now names the nonce.
    gh.devices.set(PC_A, { snapshot: snapshotFixture({ now: Date.now(), cost: 19.5 }), handled: request.nonce });
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(page.getByText('$19.50', { exact: true }).first()).toBeVisible();
    await expect(banner.getByRole('status')).toHaveCount(0);
    await selectTab(page, '설정');
    await expect(page.locator('.cloud-panel')).toContainText(REPO);
    await page.getByLabel('월 예산 · 전체 (USD)', { exact: true }).fill('321');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('설정을 저장했어요');
    expect(gh.settings!.monthlyBudget).toBe(321);
    await page.reload();
    await expect(page.getByRole('region', { name: '데이터 기준 시각' })).toContainText('QA 작업 PC');
    await selectTab(page, '설정');
    await page.getByRole('button', { name: '연결 해제', exact: true }).click();
    await expect.poll(() => cacheRecordCount(page)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('tv-google-token-v1'))).toBeNull();
    expect(gh.unexpected).toEqual([]);
    await expectNoViewportOverflow(page);
  });

  test('public repositories, malformed and rejected tokens are refused without storing anything', async ({ page }) => {
    const gh = await mockGithub(page);
    gh.public = true;
    await page.goto('/');
    await connectGithub(page, 'not-a-token');
    const alert = page.locator('.cloud-panel').getByRole('alert');
    await expect(alert).toContainText('GitHub 토큰(github_pat_');
    await connectGithub(page);
    await expect(alert).toContainText('공개 저장소는 사용할 수 없어요');
    gh.public = false;
    await connectGithub(page, 'github_pat_11WRONG0123456789abcdefABCDEF');
    await expect(alert).toContainText('GitHub 토큰이 만료됐거나 취소됐어요');
    expect(await page.evaluate(() => [localStorage.getItem('tv-google-token-v1'), localStorage.getItem('tv-google-account-v1')])).toEqual([null, null]);
    await expect(page.getByText('누적 총 토큰', { exact: true })).toHaveCount(0);
  });
});
