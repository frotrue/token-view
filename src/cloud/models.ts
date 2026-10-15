export type Source = "claude" | "codex";

export interface TokenSums {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  reasoning: number;
  cost: number;
  requests: number;
}

export interface TotalRow extends TokenSums {
  source: Source;
  firstTs: number;
  lastTs: number;
}
export interface DailyRow extends TokenSums {
  date: string;
  source: Source;
}
export interface DailyModelRow extends DailyRow {
  model: string;
}
export interface DailyProjectRow extends DailyRow {
  project: string;
}
export interface HourlyRow extends TokenSums {
  hour: number;
  source: Source;
}
export interface FineRow extends TokenSums {
  t: number;
  source: Source;
}
export interface LimitSnap {
  source: Source;
  limitId: string;
  win: string;
  ts: number;
  usedPct: number;
  windowMinutes: number;
  resetsAt: number;
  plan: string;
}
export interface Unpriced {
  source: Source;
  model: string;
  requests: number;
  tokens: number;
}

export interface SessionRow extends TokenSums {
  source: Source;
  session: string;
  project: string;
  firstTs: number;
  lastTs: number;
  models: string;
}

export interface LiveResult {
  ok: boolean;
  ts: number;
  error?: string;
  info?: Record<string, unknown>;
}
export interface StatusPage {
  id: string;
  name: string;
  url: string;
  indicator: "none" | "minor" | "major" | "critical" | "maintenance" | "unknown";
  description: string;
}
export interface Live {
  claude?: LiveResult | null;
  codex?: LiveResult | null;
  status?: { ts: number; pages: StatusPage[] } | null;
  codexInfo?: {
    ts: number;
    planType?: string;
    credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
    resetCredits?: number;
    reached?: string | null;
  };
}

export interface Dashboard {
  now: number;
  totals: TotalRow[];
  daily: DailyRow[];
  dailyModel: DailyModelRow[];
  dailyProject: DailyProjectRow[];
  hourly: HourlyRow[];
  fine: FineRow[];
  limits: LimitSnap[];
  unpriced: Unpriced[];
  sessions: SessionRow[];
}

export interface ScanStatus {
  running: boolean;
  files_total: number;
  files_done: number;
  bytes_total: number;
  bytes_done: number;
  current: string;
  last_scan_ms: number;
  last_duration_ms: number;
  new_events: number;
  last_error: string;
}

export interface PriceEntry {
  model: string;
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  long_ctx_threshold: number;
  long_input_mult: number;
  long_output_mult: number;
}
export interface Pricing {
  version: string;
  entries: PriceEntry[];
  fast_mult: number;
  web_search_usd: number;
}

export interface PricingInfo {
  pricing: Pricing;
  custom: boolean;
  defaultVersion: string;
  builtinVersion: string;
  remoteUrl: string;
}

export interface StatuslineStatus {
  settingsPath: string;
  command: string;
  connected: boolean;
  original: { command?: string } | null;
}

export interface UiSettings {
  refreshSecs: number;
  closeToTray: boolean;
  currency: "USD" | "KRW";
  krwRate: number;
  monthlyBudget: number | null;
  budgetClaude: number | null;
  budgetCodex: number | null;
  /** Poll Anthropic's (unofficial) OAuth usage endpoint with Claude Code's login. */
  claudeApi: boolean;
  /** Ask the local Codex app-server for current limits. */
  codexLive: boolean;
  serviceStatus: boolean;
  liveSecs: number;
  notify: {
    enabled: boolean;
    thresholds: number[];
    exhaust: boolean;
    budget: boolean;
    reset: boolean;
  };
}

export const DEFAULT_SETTINGS: UiSettings = {
  refreshSecs: 60,
  closeToTray: true,
  currency: "USD",
  krwRate: 1400,
  monthlyBudget: null,
  budgetClaude: null,
  budgetCodex: null,
  claudeApi: false,
  codexLive: true,
  serviceStatus: true,
  liveSecs: 300,
  notify: { enabled: true, thresholds: [80, 95], exhaust: true, budget: true, reset: false },
};
export interface Sources {
  claude: { path: string; exists: boolean }[];
  codex: { path: string; exists: boolean }[];
  claudeLimitsFile: string;
  claudeLimitsMtime: number | null;
}
