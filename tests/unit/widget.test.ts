import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDemoSnapshot } from '../../src/cloud/demo';
import type { LimitSnap } from '../../src/cloud/models';
import { clearWidget, syncWidget, widgetState } from '../../src/cloud/widget';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), readCache: vi.fn() }));
vi.mock('../../src/cloud/cache', () => ({ readCache: mocks.readCache, writeCache: vi.fn(), clearCache: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/cloud/google', () => ({
  clientId: () => null, customClientId: () => null, completeSignIn: () => null,
  revoke: vi.fn().mockResolvedValue(undefined),
}));

const row = (extra: Partial<LimitSnap> = {}): LimitSnap => ({
  source: 'claude', limitId: 'claude', win: 'five_hour', ts: 1000,
  usedPct: 42.25, windowMinutes: 300, resetsAt: 20_000, plan: 'not-for-widget', ...extra,
});
const snapshot = (limits: LimitSnap[] = []) => {
  const value = makeDemoSnapshot(10_000);
  value.dashboard.limits = limits;
  value.device.id = 'selected-pc';
  return value;
};

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.readCache.mockReset();
  // Mock the native boundary so concurrent dynamic imports use the real core API.
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: mocks.invoke } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('widgetState measured slot selection', () => {
  it('selects the newest ts per slot, breaking ties with the later array row', () => {
    const value = snapshot([
      row({ ts: 2000, usedPct: 22 }), row({ ts: 1000, usedPct: 11 }),
      row({ ts: 2000, usedPct: 33.75 }), row({ win: 'seven_day', ts: 500, usedPct: 67 }),
    ]);
    expect(widgetState(value, 'google').slots).toEqual([
      { source: 'claude', kind: '5h', usedPct: 33.75, resetsAt: 20_000, ts: 2000 },
      { source: 'claude', kind: 'week', usedPct: 67, resetsAt: 20_000, ts: 500 },
    ]);
  });

  it('prefers limitId === source across all slots, even over a newer other bucket', () => {
    const value = snapshot([
      row({ limitId: 'other', ts: 8000, usedPct: 99 }), row({ usedPct: 1 }),
      row({ source: 'codex', limitId: 'other', windowMinutes: 10080, ts: 8000 }),
      row({ source: 'codex', limitId: 'codex', windowMinutes: 300, usedPct: 8 }),
    ]);
    expect(widgetState(value, 'google').slots.map((s) => [s.source, s.kind, s.usedPct])).toEqual([
      ['claude', '5h', 1], ['codex', '5h', 8],
    ]);
  });

  it('falls back to all source rows only when no canonical limitId exists', () => {
    const value = snapshot([
      row({ limitId: 'legacy', usedPct: 9 }),
      row({ source: 'codex', limitId: 'legacy', windowMinutes: 10080, usedPct: 23 }),
    ]);
    expect(widgetState(value, 'github').slots.map((s) => [s.source, s.kind, s.usedPct])).toEqual([
      ['claude', '5h', 9], ['codex', 'week', 23],
    ]);
  });

  it('excludes Claude model-specific weekly windows', () => {
    expect(widgetState(snapshot([
      row({ win: 'seven_day_opus' }), row({ win: 'seven_day_sonnet' }),
      row({ win: 'primary' }), row({ win: 'seven_day', usedPct: 67 }),
    ]), 'google').slots.map((s) => [s.kind, s.usedPct])).toEqual([['week', 67]]);
  });

  it.each([
    [300, 'secondary', '5h'], [10080, 'primary', 'week'],
    [0, 'primary', '5h'], [0, 'secondary', 'week'],
    [60, 'primary', null], [0, 'five_hour', null],
  ] as const)('classifies Codex windowMinutes=%s win=%s as %s', (windowMinutes, win, kind) => {
    const slots = widgetState(snapshot([row({ source: 'codex', limitId: 'codex', windowMinutes, win })]), 'google').slots;
    expect(slots.map((s) => s.kind)).toEqual(kind ? [kind] : []);
  });

  it('omits absent slots, preserving a measured zero and values over 100 without rounding', () => {
    expect(widgetState(snapshot(), 'google').slots).toEqual([]);
    expect(widgetState(snapshot([row({ usedPct: 0, resetsAt: 0 }), row({ win: 'seven_day', usedPct: 104.25 })]), 'google').slots)
      .toEqual([
        { source: 'claude', kind: '5h', usedPct: 0, resetsAt: 0, ts: 1000 },
        { source: 'claude', kind: 'week', usedPct: 104.25, resetsAt: 20_000, ts: 1000 },
      ]);
  });

  it.each(['usedPct', 'resetsAt', 'ts', 'windowMinutes'] as const)('ignores nonfinite or negative %s before selection', (key) => {
    for (const n of [-1, NaN, Infinity, -Infinity]) {
      const slots = widgetState(snapshot([row(), row({ ts: 9000, [key]: n })]), 'google').slots;
      expect(slots).toHaveLength(1);
      expect(slots[0]).toEqual({ source: 'claude', kind: '5h', usedPct: 42.25, resetsAt: 20_000, ts: 1000 });
    }
  });

  it('does not fall back to unrelated buckets when the canonical rows are invalid', () => {
    expect(widgetState(snapshot([row({ usedPct: NaN }), row({ limitId: 'other' })]), 'google').slots).toEqual([]);
  });

  it('copies only the allowed state and slot fields, never credentials or estimates', () => {
    const value = {
      ...snapshot([{ ...row(), email: 'hidden', accessToken: 'hidden', estimated: true } as LimitSnap]),
      claudeHooked: false, accessToken: 'hidden', email: 'hidden', accountId: 'hidden',
    };
    expect(widgetState(value, 'github')).toEqual({
      v: 1, provider: 'github', deviceId: 'selected-pc', capturedAt: 10_000, claudeHooked: false,
      slots: [{ source: 'claude', kind: '5h', usedPct: 42.25, resetsAt: 20_000, ts: 1000 }],
    });
    expect(JSON.stringify(widgetState(value, 'github'))).not.toContain('hidden');
  });
});

describe('native widget bridge', () => {
  it.each(['web', 'desktop', ''])('does not invoke native commands for target %s', (target) => {
    vi.stubEnv('VITE_TARGET', target);
    syncWidget(snapshot([row()]), 'google');
    clearWidget();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('sends the allowlisted JSON and clears only on mobile', async () => {
    vi.stubEnv('VITE_TARGET', 'mobile');
    const value = snapshot([row()]);
    expect(syncWidget(value, 'github')).toBeUndefined();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('plugin:limits-widget|update', { json: JSON.stringify(widgetState(value, 'github')) }, undefined));
    expect(clearWidget()).toBeUndefined();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('plugin:limits-widget|clear', {}, undefined));
  });

  it('silently ignores native rejections', async () => {
    vi.stubEnv('VITE_TARGET', 'mobile');
    mocks.invoke.mockRejectedValue(new Error('native unavailable'));
    expect(() => { syncWidget(snapshot(), 'google'); clearWidget(); }).not.toThrow();
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['plugin:limits-widget|update', 'plugin:limits-widget|clear']));
  });
});

describe('cloud installation and account lifecycle', () => {
  async function reader(provider: 'google' | 'github', mode?: 'import' | 'demo') {
    vi.stubEnv('VITE_TARGET', 'mobile');
    const data = new Map([
      ['tv-google-account-v1', JSON.stringify({ userId: 'reader', provider })],
      ['tv-google-token-v1', JSON.stringify({ accessToken: 'test-only', expiresAt: Date.now() + 3_600_000 })],
      ['tv-selected:reader', 'selected-pc'],
    ]);
    if (mode) data.set('tv-local-mode-v1', mode);
    const events = new Map<string, (event: { key: string }) => void>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: mocks.invoke }, addEventListener: (name: string, fn: (event: { key: string }) => void) => events.set(name, fn) });
    vi.stubGlobal('document', { visibilityState: 'hidden', addEventListener: vi.fn() });
    vi.stubGlobal('navigator', { onLine: false });
    mocks.readCache.mockResolvedValue(snapshot([row()]));
    const { cloud } = await import('../../src/cloud');
    await cloud.initialize();
    return { cloud, data, events };
  }

  it.each(['google', 'github'] as const)('syncs a cached %s cloud snapshot and clears on logout', async (provider) => {
    const { cloud } = await reader(provider);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('plugin:limits-widget|update', {
      json: JSON.stringify(widgetState(snapshot([row()]), provider)),
    }, undefined));
    mocks.invoke.mockClear();
    await cloud.signOut();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('plugin:limits-widget|clear', {}, undefined));
  });

  it.each(['import', 'demo'] as const)('does not sync a restored %s snapshot with a remembered account', async (mode) => {
    await reader('google', mode);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('does not sync newly loaded demo or imported snapshots', async () => {
    const { cloud } = await reader('google');
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    mocks.invoke.mockClear();
    await cloud.loadDemo();
    const json = JSON.stringify(makeDemoSnapshot());
    await cloud.importFile({ size: json.length, text: async () => json } as File);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('clears the widget before restoring a changed account', async () => {
    const { data, events } = await reader('google');
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    mocks.invoke.mockClear();
    data.set('tv-google-account-v1', JSON.stringify({ userId: 'next-reader', provider: 'github' }));
    data.set('tv-selected:next-reader', 'selected-pc');
    events.get('storage')!({ key: 'tv-google-account-v1' });
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['plugin:limits-widget|clear', 'plugin:limits-widget|update']));
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['plugin:limits-widget|clear', 'plugin:limits-widget|update']);
    expect(JSON.parse(mocks.invoke.mock.calls[1][1].json).provider).toBe('github');
  });
});
