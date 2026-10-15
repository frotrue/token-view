import { describe, expect, it } from 'vitest';
import { buildLimitViews, dailySeries, project } from '../../src/forecast';
import { makeDemoSnapshot } from '../../src/cloud/demo';
import { calendarDateAt } from '../../src/format';

describe('captured-time analysis on mobile', () => {
  it('uses the collecting PC calendar across time zones and month boundaries', () => {
    const capturedAt = Date.UTC(2026, 8, 30, 16, 30);
    const seoul = calendarDateAt(capturedAt, 'Asia/Seoul');
    expect([seoul.getFullYear(), seoul.getMonth(), seoul.getDate(), seoul.getHours(), seoul.getMinutes()]).toEqual([2026, 9, 1, 1, 30]);
    const utc = calendarDateAt(capturedAt, 'UTC');
    expect([utc.getMonth(), utc.getDate(), utc.getHours()]).toEqual([8, 30, 16]);
    expect(calendarDateAt(capturedAt, 'invalid-zone').getTime()).toBe(capturedAt);
  });
  it('does not invent a reset because an offline snapshot is viewed later', () => {
    const capturedAt = Date.UTC(2026, 9, 10, 10);
    const snapshot = makeDemoSnapshot(capturedAt);
    const before = buildLimitViews(snapshot.dashboard, capturedAt).find((v) => v.source === 'codex');
    expect(before?.lastPct).toBe(33);
    expect(before?.isReset).toBe(false);
    const later = buildLimitViews(snapshot.dashboard, capturedAt + 24 * 3_600_000).find((v) => v.source === 'codex');
    expect(later?.isReset).toBe(true);
    // The mobile UI must keep using capturedAt, not the device wall clock.
    expect(buildLimitViews(snapshot.dashboard, snapshot.capturedAt).find((v) => v.source === 'codex')?.nowPct).toBe(before?.nowPct);
  });
  it('keeps capture-month cost when a saved snapshot is opened next month', () => {
    const capturedAt = new Date(2026, 8, 30, 18).getTime();
    const snapshot = makeDemoSnapshot(capturedAt);
    const series = dailySeries(snapshot.dashboard.daily, 'cost', 'all');
    const captured = project(series, 600, new Date(capturedAt));
    expect(captured.mtd).toBeGreaterThan(0);
    expect(captured.today).toBeGreaterThan(0);
    expect(project(series, 600, new Date(2026, 9, 1)).mtd).toBe(0);
  });
});
