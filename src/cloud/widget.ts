import type { CloudSnapshot } from './types';
import type { LimitSnap, Source } from './models';

export interface WidgetSlot {
  source: Source;
  kind: '5h' | 'week';
  usedPct: number;
  resetsAt: number;
  ts: number;
}
export interface WidgetState {
  v: 1;
  provider: 'google' | 'github';
  deviceId: string;
  capturedAt: number;
  claudeHooked: boolean;
  slots: WidgetSlot[];
}

// Keep these selection rules identical to mobile/plugin-limits-widget/android/src/main/java/SnapshotLimits.kt.
export function widgetState(snapshot: CloudSnapshot, provider: 'google' | 'github'): WidgetState {
  const slots: WidgetSlot[] = [];
  for (const source of ['claude', 'codex'] as const) {
    const rows = snapshot.dashboard.limits.filter((row) => row.source === source);
    const primary = rows.filter((row) => row.limitId === source);
    const selected: Partial<Record<WidgetSlot['kind'], LimitSnap>> = {};
    for (const row of primary.length ? primary : rows) {
      if (![row.usedPct, row.resetsAt, row.ts, row.windowMinutes].every((n) => Number.isFinite(n) && n >= 0)) continue;
      const kind = source === 'claude'
        ? row.win === 'five_hour' ? '5h' : row.win === 'seven_day' ? 'week' : null
        : row.windowMinutes === 300 || (row.windowMinutes === 0 && row.win === 'primary') ? '5h'
          : row.windowMinutes === 10080 || (row.windowMinutes === 0 && row.win === 'secondary') ? 'week' : null;
      if (kind && (!selected[kind] || row.ts >= selected[kind].ts)) selected[kind] = row;
    }
    for (const kind of ['5h', 'week'] as const) {
      const row = selected[kind];
      if (row) slots.push({ source, kind, usedPct: row.usedPct, resetsAt: row.resetsAt, ts: row.ts });
    }
  }
  return { v: 1, provider, deviceId: snapshot.device.id, capturedAt: snapshot.capturedAt, claudeHooked: snapshot.claudeHooked, slots };
}

export function syncWidget(snapshot: CloudSnapshot, provider: WidgetState['provider']): void {
  if (import.meta.env.VITE_TARGET !== 'mobile') return;
  void (async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('plugin:limits-widget|update', { json: JSON.stringify(widgetState(snapshot, provider)) });
  })().catch(() => {});
}

export function clearWidget(): void {
  if (import.meta.env.VITE_TARGET !== 'mobile') return;
  void (async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('plugin:limits-widget|clear');
  })().catch(() => {});
}
