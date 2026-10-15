import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cloud, currentSharedSettings, getSnapshot, isDesktop, onCloudData, saveSharedSettings } from "./cloud";
import { DEFAULT_SETTINGS, type Dashboard, type Live, type Pricing, type PricingInfo, type ScanStatus, type Sources, type StatuslineStatus, type TokenSums, type UiSettings } from "./cloud/models";
import { emptyPricing } from "./cloud/demo";
export * from "./cloud/models";

function snapshot() {
  const value = getSnapshot();
  if (!value) throw new Error("클라우드에 연결하거나 JSON 데이터를 불러와 주세요.");
  return value;
}
function mobileStatus(): ScanStatus {
  return { running: false, files_total: 0, files_done: 0, bytes_total: 0, bytes_done: 0, current: "", last_scan_ms: getSnapshot()?.capturedAt ?? 0, last_duration_ms: 0, new_events: 0, last_error: "" };
}
function desktopOnly<T>(): Promise<T> { return Promise.reject(new Error("이 기능은 PC 앱에서 사용할 수 있어요.")); }

export const api = {
  dashboard: (): Promise<Dashboard> => isDesktop ? invoke("get_dashboard") : Promise.resolve().then(() => snapshot().dashboard),
  status: (): Promise<ScanStatus> => isDesktop ? invoke("get_status") : Promise.resolve(mobileStatus()),
  rescan: () => isDesktop ? invoke<void>("rescan") : cloud.refresh(),
  rebuild: () => isDesktop ? invoke<void>("rebuild") : desktopOnly<void>(),
  pricing: (): Promise<PricingInfo> => isDesktop ? invoke("get_pricing") : Promise.resolve(getSnapshot()?.pricing ?? emptyPricing),
  setPricing: (pricing: Pricing | null): Promise<PricingInfo> => isDesktop ? invoke("set_pricing", { pricing }) : desktopOnly(),
  refreshPricing: (): Promise<PricingInfo> => isDesktop ? invoke("refresh_pricing") : desktopOnly(),
  statusline: (): Promise<StatuslineStatus | null> => isDesktop ? invoke("statusline_status") : Promise.resolve(null),
  statuslineConnect: (connect: boolean): Promise<StatuslineStatus> => isDesktop ? invoke("statusline_connect", { connect }) : desktopOnly(),
  live: (): Promise<Live> => isDesktop ? invoke("get_live") : Promise.resolve(getSnapshot()?.live ?? {}),
  refreshLive: async (): Promise<Live> => { if (isDesktop) return invoke("refresh_live_now"); await cloud.requestRefresh(); return getSnapshot()?.live ?? {}; },
  updateTray: (tooltip: string, bars: { pct: number; color: string }[]) => isDesktop ? invoke<void>("update_tray", { tooltip, bars }) : Promise.resolve(),
  exportData: async (kind: "events" | "daily" | "json", path: string): Promise<number> => {
    if (isDesktop) return invoke("export_data", { kind, path });
    if (kind !== "json") return desktopOnly();
    await cloud.downloadSnapshot(); return 1;
  },
  inTauri: isDesktop,
  settings: async (): Promise<UiSettings> => {
    const s = isDesktop ? await invoke<Partial<UiSettings>>("get_settings") : currentSharedSettings();
    return { ...DEFAULT_SETTINGS, ...s, notify: { ...DEFAULT_SETTINGS.notify, ...("notify" in s ? s.notify : {}) } };
  },
  setSettings: (settings: UiSettings) => isDesktop ? invoke<void>("set_settings", { settings }) : saveSharedSettings(settings),
  sources: (): Promise<Sources> => isDesktop ? invoke("get_sources") : Promise.resolve({ claude: [], codex: [], claudeLimitsFile: "", claudeLimitsMtime: getSnapshot()?.claudeHooked ? getSnapshot()!.capturedAt : null }),
  onStatus: (cb: (s: ScanStatus) => void): Promise<UnlistenFn> => isDesktop ? listen<ScanStatus>("scan-status", (e) => cb(e.payload)) : Promise.resolve(onCloudData(() => cb(mobileStatus()))),
  onData: async (cb: (s: ScanStatus) => void): Promise<UnlistenFn> => {
    if (!isDesktop) return onCloudData(() => cb(mobileStatus()));
    const handlers = await Promise.all([
      listen<ScanStatus>("data-updated", (e) => cb(e.payload)),
      listen("cloud-settings-updated", () => { void invoke<ScanStatus>("get_status").then(cb).catch(() => {}); }),
    ]);
    return () => handlers.forEach((stop) => stop());
  },
};
export const totalTokens = (s: TokenSums) => s.input + s.cacheWrite + s.cacheRead + s.output;
