import { z } from 'zod';
import type { CloudSnapshot, SharedSettings } from './types';
import type { Dashboard } from './models';

export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const number = z.number().finite().nonnegative();
const timestamp = number.max(8.64e15);
const text = z.string().max(2048);
const source = z.enum(['claude', 'codex']);
const tokens = z.object({ input: number, cacheWrite: number, cacheRead: number, output: number, reasoning: number, cost: number, requests: number });
const daily = tokens.extend({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), source });
const rows = <T extends z.ZodType>(schema: T, max = 100_000) => z.array(schema).max(max);
export const dashboardSchema = z.object({
  now: timestamp,
  totals: rows(tokens.extend({ source, firstTs: timestamp, lastTs: timestamp }), 10),
  daily: rows(daily),
  dailyModel: rows(daily.extend({ model: text })),
  dailyProject: rows(daily.extend({ project: text })),
  hourly: rows(tokens.extend({ hour: timestamp, source })),
  fine: rows(tokens.extend({ t: timestamp, source })),
  limits: rows(z.object({ source, limitId: text, win: text, ts: timestamp, usedPct: number.max(1_000_000), windowMinutes: number, resetsAt: timestamp, plan: text })),
  unpriced: rows(z.object({ source, model: text, requests: number, tokens: number })),
  sessions: rows(tokens.extend({ source, session: text, project: text, firstTs: timestamp, lastTs: timestamp, models: text })),
});
export const sharedSettingsSchema = z.object({
  currency: z.enum(['USD', 'KRW']),
  krwRate: z.number().finite().positive().max(1_000_000),
  monthlyBudget: number.max(1_000_000_000).nullable(),
  budgetClaude: number.max(1_000_000_000).nullable(),
  budgetCodex: number.max(1_000_000_000).nullable(),
});
const price = z.object({ model: text, input: number, output: number, cache_write_5m: number, cache_write_1h: number, cache_read: number, long_ctx_threshold: number, long_input_mult: number, long_output_mult: number });
const pricing = z.object({
  pricing: z.object({ version: text, entries: rows(price, 10_000), fast_mult: number, web_search_usd: number }),
  custom: z.boolean(), defaultVersion: text, builtinVersion: text, remoteUrl: text,
});
const creditInfo = z.object({ hasCredits: z.boolean(), unlimited: z.boolean(), balance: text.nullable().optional() });
const liveInfo = z.object({ windows: number.optional(), ts: timestamp.nullable().optional(), planType: text.nullable().optional(), credits: creditInfo.nullable().optional(), resetCredits: number.nullable().optional(), reached: text.nullable().optional() });
const liveResult = z.object({ ok: z.boolean(), ts: timestamp, error: z.string().max(200).optional(), info: liveInfo.optional() });
const live = z.object({
  claude: liveResult.nullable().optional(), codex: liveResult.nullable().optional(),
  status: z.object({ ts: timestamp, pages: rows(z.object({ id: text, name: text, url: z.string().url().refine((v) => v.startsWith('https://')), indicator: z.enum(['none', 'minor', 'major', 'critical', 'maintenance', 'unknown']), description: text }), 10) }).nullable().optional(),
  codexInfo: liveInfo.extend({ ts: timestamp }).optional(),
});
const snapshot = z.object({
  schemaVersion: z.literal(1), device: z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(128) }),
  capturedAt: timestamp, timezone: z.string().max(100), dashboard: dashboardSchema,
  pricing, settings: sharedSettingsSchema, live, claudeHooked: z.boolean(),
});

export function parseSnapshot(value: unknown): CloudSnapshot {
  const parsed = snapshot.safeParse(value);
  if (!parsed.success) throw new Error('지원하지 않거나 손상된 데이터예요. Token View JSON 파일인지 확인해 주세요.');
  if (parsed.data.capturedAt > Date.now() + 5 * 60_000) throw new Error('데이터의 수집 시각이 미래로 설정되어 있어요. PC 시간을 확인해 주세요.');
  // Provider responses may include null optional fields; the UI treats absent values identically.
  return parsed.data as unknown as CloudSnapshot;
}

export function sharedSettings(value: unknown): SharedSettings {
  const parsed = sharedSettingsSchema.safeParse(value);
  if (!parsed.success) throw new Error('환율은 0보다 커야 하고 예산은 0 이상의 숫자여야 해요.');
  return parsed.data;
}

export function parseDashboard(value: unknown): Dashboard {
  const parsed = dashboardSchema.safeParse(value);
  if (!parsed.success) throw new Error('대시보드 JSON 형식이 올바르지 않아요.');
  return parsed.data;
}
