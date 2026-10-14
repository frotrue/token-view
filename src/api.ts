import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
}

export const DEFAULT_SETTINGS: UiSettings = {
  refreshSecs: 60,
  closeToTray: true,
  currency: "USD",
  krwRate: 1400,
  monthlyBudget: null,
  budgetClaude: null,
  budgetCodex: null,
};

export interface Sources {
  claude: { path: string; exists: boolean }[];
  codex: { path: string; exists: boolean }[];
  claudeLimitsFile: string;
  claudeLimitsMtime: number | null;
}

// Outside the Tauri shell (plain `vite` in a browser) serve a local snapshot so the UI
// can be developed without the backend. The file is git-ignored.
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
async function mock<T>(cmd: string): Promise<T> {
  const all = await fetch("/dev-snapshot.json").then((r) => r.json());
  return all[cmd] as T;
}
const call = <T,>(cmd: string, args?: Record<string, unknown>) => (inTauri ? invoke<T>(cmd, args) : mock<T>(cmd));

export const api = {
  dashboard: () => call<Dashboard>("get_dashboard"),
  status: () => call<ScanStatus>("get_status"),
  rescan: () => invoke<void>("rescan"),
  rebuild: () => invoke<void>("rebuild"),
  pricing: () => call<PricingInfo>("get_pricing"),
  setPricing: (pricing: Pricing | null) => invoke<PricingInfo>("set_pricing", { pricing }),
  refreshPricing: () => invoke<PricingInfo>("refresh_pricing"),
  statusline: () => (inTauri ? invoke<StatuslineStatus>("statusline_status") : Promise.resolve(null)),
  statuslineConnect: (connect: boolean) => invoke<StatuslineStatus>("statusline_connect", { connect }),
  inTauri,
  settings: async () => ({ ...DEFAULT_SETTINGS, ...(await call<Partial<UiSettings>>("get_settings")) }),
  setSettings: (settings: UiSettings) => invoke<void>("set_settings", { settings }),
  sources: () => call<Sources>("get_sources"),
  onStatus: (cb: (s: ScanStatus) => void): Promise<UnlistenFn> =>
    inTauri ? listen<ScanStatus>("scan-status", (e) => cb(e.payload)) : Promise.resolve(() => {}),
  onData: (cb: (s: ScanStatus) => void): Promise<UnlistenFn> =>
    inTauri ? listen<ScanStatus>("data-updated", (e) => cb(e.payload)) : Promise.resolve(() => {}),
};

export const totalTokens = (s: TokenSums) => s.input + s.cacheWrite + s.cacheRead + s.output;
