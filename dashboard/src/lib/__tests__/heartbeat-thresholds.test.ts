/**
 * P2a Phase 3 contract: tightened staleness thresholds in getHealthStatus.
 *
 * The thresholds were tightened from the old 5h-stale / 24h-down to a
 * fleet-appropriate 75-min-stale / 4h-down so a crashed agent surfaces within
 * minutes, not hours. These boundary tests pin the new behaviour — and the
 * "tightening" cases (90 min and 300 min) would have read healthy/stale under
 * the OLD thresholds, so they double as a regression guard against a revert.
 */
import { describe, it, expect } from 'vitest';
import { getHealthStatus } from '@/lib/data/heartbeats';
import type { Heartbeat } from '@/lib/types';

function hbAgedMinutes(minutes: number): Heartbeat {
  return {
    agent: 'thresh-agent',
    org: 'testorg',
    status: 'idle',
    last_heartbeat: new Date(Date.now() - minutes * 60_000).toISOString(),
  };
}

describe('getHealthStatus tightened thresholds (75 min stale / 240 min down)', () => {
  it('reports healthy well inside the stale window', () => {
    expect(getHealthStatus(hbAgedMinutes(0))).toBe('healthy');
    expect(getHealthStatus(hbAgedMinutes(30))).toBe('healthy');
    expect(getHealthStatus(hbAgedMinutes(70))).toBe('healthy');
  });

  it('reports stale past the 75-min watchdog window but before 4h', () => {
    expect(getHealthStatus(hbAgedMinutes(90))).toBe('stale');
    expect(getHealthStatus(hbAgedMinutes(150))).toBe('stale');
    expect(getHealthStatus(hbAgedMinutes(230))).toBe('stale');
  });

  it('reports down past the 4h cron-cycle window', () => {
    expect(getHealthStatus(hbAgedMinutes(300))).toBe('down');
    expect(getHealthStatus(hbAgedMinutes(1000))).toBe('down');
  });

  it('reports down when no heartbeat has ever been recorded', () => {
    expect(getHealthStatus({ agent: 'x', org: '', status: 'unknown' })).toBe('down');
  });

  it('tightening regression: 90 min is stale (would have been healthy at the old 300-min threshold)', () => {
    expect(getHealthStatus(hbAgedMinutes(90))).not.toBe('healthy');
  });

  it('tightening regression: 300 min is down (would have been stale at the old 1440-min threshold)', () => {
    expect(getHealthStatus(hbAgedMinutes(300))).toBe('down');
  });
});
