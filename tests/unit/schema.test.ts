import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeDemoSnapshot } from '../../src/cloud/demo';
import { parseDashboard, parseSnapshot, sharedSettings, validateConfiguration } from '../../src/cloud/schema';

const keyFor = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role }))}.test-signature`;
describe('untrusted cloud and file data', () => {
  it('reads a full fixture emitted by the native Rust snapshot sanitizer', () => {
    const native = JSON.parse(readFileSync(new URL('../fixtures/native-snapshot.json', import.meta.url), 'utf8'));
    const parsed = parseSnapshot(native);
    expect(parsed.device.id).toBe(native.device.id);
    expect(parsed.dashboard.totals).toEqual(native.dashboard.totals);
    expect(parsed.live.codexInfo?.planType).toBe(native.live.codexInfo.planType);
    expect(parsed.settings).toEqual(native.settings);
  });
  it('accepts the data used by all dashboard screens', () => {
    const value = makeDemoSnapshot();
    expect(parseSnapshot(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(parseDashboard(value.dashboard).daily.length).toBe(42);
  });
  it('rejects nonfinite/negative usage, malformed arrays, future capture, and unknown formats', () => {
    const value = makeDemoSnapshot();
    expect(() => parseSnapshot({ ...value, schemaVersion: 2 })).toThrow();
    expect(() => parseSnapshot({ ...value, capturedAt: Date.now() + 600_000 })).toThrow();
    expect(() => parseDashboard({ ...value.dashboard, totals: [{ ...value.dashboard.totals[0], cost: -1 }] })).toThrow();
    expect(() => parseDashboard({ ...value.dashboard, hourly: 'not-an-array' })).toThrow();
    expect(() => parseDashboard({ ...value.dashboard, daily: [{ ...value.dashboard.daily[0], input: Infinity }] })).toThrow();
  });
  it('strips unexpected credential/desktop keys from parsed payloads', () => {
    const value = makeDemoSnapshot();
    const parsed = parseSnapshot({ ...value, accessToken: 'do-not-copy', settings: { ...value.settings, claudeApi: true, credentials: 'secret' }, live: { codex: { ok: true, ts: Date.now(), info: { accessToken: 'secret' } } } });
    expect(JSON.stringify(parsed)).not.toContain('secret');
    expect(parsed.settings).not.toHaveProperty('claudeApi');
  });
  it('validates shared preferences without synchronizing PC configuration', () => {
    const settings = makeDemoSnapshot().settings;
    expect(sharedSettings({ ...settings, refreshSecs: 1 })).not.toHaveProperty('refreshSecs');
    expect(() => sharedSettings({ ...settings, krwRate: 0 })).toThrow();
    expect(() => sharedSettings({ ...settings, monthlyBudget: -3 })).toThrow();
    expect(sharedSettings({ ...settings, monthlyBudget: null }).monthlyBudget).toBeNull();
  });
});
describe('public-only backend configuration', () => {
  it('accepts publishable and legacy anon keys', () => {
    expect(validateConfiguration('https://example.supabase.co/', 'sb_publishable_abc_123').url).toBe('https://example.supabase.co');
    expect(validateConfiguration('https://example.supabase.co', keyFor('anon')).anonKey).toBe(keyFor('anon'));
  });
  it('rejects privileged keys and URLs carrying credentials, paths, or insecure schemes', () => {
    for (const key of ['sb_secret_never', keyFor('service_role'), keyFor('authenticated'), 'invalid']) expect(() => validateConfiguration('https://example.supabase.co', key)).toThrow();
    for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?token=secret', 'javascript:alert(1)']) expect(() => validateConfiguration(url, keyFor('anon'))).toThrow();
    expect(() => validateConfiguration('http://localhost:54321', keyFor('anon'))).toThrow();
    expect(validateConfiguration('http://localhost:54321', keyFor('anon'), true).url).toBe('http://localhost:54321');
  });
});
