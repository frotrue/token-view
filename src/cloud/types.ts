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
export interface CloudDevice { id: string; name: string; capturedAt: number; checkedAt: number }
export interface DesktopCloudStatus {
  available: boolean; customClient: boolean; clientId: string; enabled: boolean;
  deviceId: string; deviceName: string; email: string | null; authenticated: boolean; signingIn: boolean;
  lastUploadAt: number | null; lastCheckAt: number | null; lastUploadBytes: number | null;
  lastError: string | null; persistentSession: boolean;
}
export interface CloudViewState {
  mode: 'desktop' | 'cloud' | 'import' | 'demo';
  initialized: boolean;
  /** A Google OAuth client id is configured for this build/device. */
  available: boolean; customClient: boolean; clientId: string;
  /** A usable Google token is present. */
  authenticated: boolean;
  /** An account is remembered but its token expired: data stays, one tap reconnects. */
  needsReconnect: boolean;
  signingIn: boolean;
  email: string | null; deviceName: string; enabled: boolean;
  persistentSession: boolean; devices: CloudDevice[]; selectedDeviceId: string | null;
  busy: boolean; error: string | null; warning: string | null; offline: boolean;
  lastFetchedAt: number | null; capturedAt: number | null;
  lastUploadAt: number | null; lastCheckAt: number | null; lastUploadBytes: number | null;
  refreshRequestedAt: number | null; hasData: boolean;
}
export interface DesktopConfiguration { deviceName: string; enabled: boolean; clientId: string; clientSecret: string }
