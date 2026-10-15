import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeDemoSnapshot } from '../../src/cloud/demo';
import { parseDashboard, parseSnapshot, sharedSettings } from '../../src/cloud/schema';
import { validClientId } from '../../src/cloud/google';
import { validRepo, validToken } from '../../src/cloud/github';

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
describe('Google OAuth client configuration', () => {
  it('accepts only Google OAuth client ids', () => {
    expect(validClientId('1234-abc.apps.googleusercontent.com')).toBe(true);
    for (const id of ['', 'https://evil.example', 'abc.apps.googleusercontent.com.evil.example', 'a b.apps.googleusercontent.com']) expect(validClientId(id)).toBe(false);
  });
});
describe('GitHub repository configuration', () => {
  it('accepts owner/name repositories and fine-grained or classic tokens only', () => {
    expect(validRepo('frotrue/token-view-data')).toBe(true);
    for (const repo of ['', 'noslash', 'a/b/c', 'a/.git', 'a b/c', '../x']) expect(validRepo(repo)).toBe(false);
    expect(validToken('github_pat_11ABCDEF0123456789abcdef')).toBe(true);
    expect(validToken('ghp_0123456789abcdefghijAB')).toBe(true);
    for (const token of ['', 'gho_0123456789abcdefghij', 'github_pat_with space 0123456789']) expect(validToken(token)).toBe(false);
  });
});
