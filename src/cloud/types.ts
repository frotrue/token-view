import type { Dashboard, Live, PricingInfo, UiSettings } from './models';

export type SharedSettings = Pick<UiSettings, 'currency' | 'krwRate' | 'monthlyBudget' | 'budgetClaude' | 'budgetCodex'>;
export interface CloudSnapshot {
  schemaVersion: 1;
  device: { id: string; name: string };
  capturedAt: number;
  timezone: string;
  dashboard: Dashboard;
  pricing: PricingInfo;
  settings: SharedSettings;
  live: Live;
  claudeHooked: boolean;
}
export interface CloudDevice { id: string; name: string; capturedAt: number; uploadedAt: number }
export interface DesktopCloudStatus {
  configured: boolean; enabled: boolean; url: string; anonKey: string;
  deviceId: string; deviceName: string; email: string | null; authenticated: boolean;
  lastUploadAt: number | null; lastError: string | null; persistentSession: boolean;
}
export interface CloudViewState {
  mode: 'desktop' | 'cloud' | 'import' | 'demo';
  initialized: boolean; configured: boolean; authenticated: boolean;
  email: string | null; url: string; anonKey: string; deviceName: string; enabled: boolean;
  persistentSession: boolean; devices: CloudDevice[]; selectedDeviceId: string | null;
  busy: boolean; error: string | null; warning: string | null; offline: boolean;
  lastFetchedAt: number | null; capturedAt: number | null; lastUploadAt: number | null;
  refreshRequestedAt: number | null; hasData: boolean;
}
export interface CloudConfiguration { url: string; anonKey: string; deviceName?: string; enabled?: boolean }
