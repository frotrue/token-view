import { DEFAULT_SETTINGS, type DailyRow, type TokenSums } from './models';
import type { CloudSnapshot } from './types';

export const emptyPricing = { pricing: { version: 'import', entries: [], fast_mult: 1, web_search_usd: 0 }, custom: false, defaultVersion: 'import', builtinVersion: 'import', remoteUrl: '' };
const sum = (cost: number, requests: number): TokenSums => ({ input: requests * 2900, cacheWrite: requests * 400, cacheRead: requests * 12000, output: requests * 900, reasoning: requests * 300, cost, requests });
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function makeDemoSnapshot(now = Date.now()): CloudSnapshot {
  const daily: DailyRow[] = [];
  for (let days = 20; days >= 0; days--) {
    const date = new Date(now); date.setDate(date.getDate() - days);
    for (const source of ['claude', 'codex'] as const) {
      const requests = Math.round((source === 'claude' ? 30 : 22) + 12 * Math.sin(days * 1.7) + (days % 4) * 5);
      daily.push({ date: dayKey(date), source, ...sum(requests * (source === 'claude' ? 0.37 : 0.19), requests) });
    }
  }
  const recent = Math.floor(now / 600_000) * 600_000;
  const fine = Array.from({ length: 60 }, (_, i) => ({ t: recent - (59 - i) * 600_000, source: i % 2 ? 'claude' as const : 'codex' as const, ...sum(0.4 + (i % 4) * 0.13, 2 + i % 3) }));
  const hourly = Array.from({ length: 24 * 14 }, (_, i) => ({ hour: Math.floor(now / 3_600_000) * 3_600_000 - i * 3_600_000, source: i % 2 ? 'claude' as const : 'codex' as const, ...sum(i % 24 < 8 ? 0 : 0.4 + (i % 6) * 0.22, i % 24 < 8 ? 0 : 4 + i % 3) }));
  return {
    schemaVersion: 1, device: { id: '00000000-0000-4000-8000-000000000001', name: '샘플 작업 PC' }, capturedAt: now, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dashboard: {
      now, daily, fine, hourly,
      totals: (['claude', 'codex'] as const).map((source) => ({ source, firstTs: now - 20 * 86_400_000, lastTs: now, ...daily.filter((r) => r.source === source).reduce<TokenSums>((a, r) => ({ input: a.input + r.input, cacheWrite: a.cacheWrite + r.cacheWrite, cacheRead: a.cacheRead + r.cacheRead, output: a.output + r.output, reasoning: a.reasoning + r.reasoning, cost: a.cost + r.cost, requests: a.requests + r.requests }), sum(0, 0)) })),
      dailyModel: daily.map((r) => ({ ...r, model: r.source === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.4' })),
      dailyProject: daily.map((r) => ({ ...r, project: r.source === 'claude' ? 'token-view' : 'personal-site' })),
      limits: (['claude', 'codex'] as const).flatMap((source) => Array.from({ length: 6 }, (_, i) => ({ source, limitId: source, win: source === 'claude' ? 'five_hour' : 'primary', ts: now - (5 - i) * 30 * 60_000, usedPct: (source === 'claude' ? 16 : 8) + i * (source === 'claude' ? 8 : 5), windowMinutes: 300, resetsAt: now + 2 * 3_600_000, plan: '샘플' }))),
      unpriced: [],
      sessions: Array.from({ length: 12 }, (_, i) => ({ source: i % 2 ? 'claude' as const : 'codex' as const, session: `sample-session-${i + 1}`, project: i % 2 ? 'token-view' : 'personal-site', firstTs: now - (i + 2) * 3_600_000, lastTs: now - (i + 1) * 3_600_000, models: i % 2 ? 'claude-sonnet-4-6' : 'gpt-5.4', ...sum(3 + i * 0.4, 15 + i) })),
    },
    pricing: emptyPricing, settings: { currency: DEFAULT_SETTINGS.currency, krwRate: DEFAULT_SETTINGS.krwRate, monthlyBudget: 600, budgetClaude: 400, budgetCodex: 200 },
    live: { claude: { ok: true, ts: now }, codex: { ok: true, ts: now } }, claudeHooked: true,
  };
}
