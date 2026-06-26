/**
 * N4 Phase A.2 — pure computeRollups logic tests for the Dispatches view island.
 *
 * No React, no side effects. Tests computeRollups and the SSE dedup/prepend/update
 * state-update patterns used by DispatchesView in isolation.
 *
 * Pattern mirrors dashboard/src/lib/__tests__/runtime-tree.test.ts and
 * dispatches-rollup.test.ts (CTX_ROOT + dynamic import to isolate DB init).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { RunRow, TeamRow } from '@/lib/types';

// dispatch-rollup.ts is client-safe (no DB), so no CTX_ROOT needed.
let computeRollups: typeof import('@/lib/data/dispatch-rollup')['computeRollups'];
let LIVE_RUN_STATES: typeof import('@/lib/data/dispatch-rollup')['LIVE_RUN_STATES'];

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const mod = await import('@/lib/data/dispatch-rollup');
  computeRollups = mod.computeRollups;
  LIVE_RUN_STATES = mod.LIVE_RUN_STATES;
});

// ---- Fixtures ----

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    run_id: 'run-test-001',
    team_id: 'team-alpha',
    state: 'live',
    lane: null,
    native_id: null,
    budget_reserved: 1000,
    budget_spent_estimate: 500,
    cancel_generation: null,
    epoch: null,
    heartbeat: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeTeam(overrides: Partial<TeamRow> = {}): TeamRow {
  return {
    team_id: 'team-alpha',
    cancel_generation: 0,
    last_cancel_at: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---- LIVE_RUN_STATES ----

describe('LIVE_RUN_STATES', () => {
  it('includes dispatching, live, and pending', () => {
    expect(LIVE_RUN_STATES).toContain('dispatching');
    expect(LIVE_RUN_STATES).toContain('live');
    expect(LIVE_RUN_STATES).toContain('pending');
  });

  it('does not include done or failed', () => {
    expect(LIVE_RUN_STATES).not.toContain('done');
    expect(LIVE_RUN_STATES).not.toContain('failed');
  });
});

// ---- computeRollups ----

describe('computeRollups', () => {
  it('returns empty array for no runs', () => {
    expect(computeRollups([], [])).toEqual([]);
  });

  it('groups runs by team_id', () => {
    const runs = [
      makeRun({ run_id: 'run-1', team_id: 'team-alpha' }),
      makeRun({ run_id: 'run-2', team_id: 'team-beta' }),
      makeRun({ run_id: 'run-3', team_id: 'team-alpha' }),
    ];
    const rollups = computeRollups(runs, []);
    expect(rollups).toHaveLength(2);
    const alpha = rollups.find((r) => r.team_id === 'team-alpha');
    expect(alpha?.runs).toHaveLength(2);
    const beta = rollups.find((r) => r.team_id === 'team-beta');
    expect(beta?.runs).toHaveLength(1);
  });

  it('counts liveCount only for LIVE_RUN_STATES runs', () => {
    const runs = [
      makeRun({ run_id: 'run-live', team_id: 'team-alpha', state: 'live' }),
      makeRun({ run_id: 'run-done', team_id: 'team-alpha', state: 'done' }),
      makeRun({ run_id: 'run-pending', team_id: 'team-alpha', state: 'pending' }),
    ];
    const rollups = computeRollups(runs, []);
    const alpha = rollups.find((r) => r.team_id === 'team-alpha');
    expect(alpha?.liveCount).toBe(2); // 'live' + 'pending'
  });

  it('sums reserved only for live runs, excludes terminal states', () => {
    const runs = [
      makeRun({ run_id: 'run-live', team_id: 'team-alpha', state: 'live', budget_reserved: 800 }),
      makeRun({ run_id: 'run-done', team_id: 'team-alpha', state: 'done', budget_reserved: 500 }),
    ];
    const rollups = computeRollups(runs, []);
    const alpha = rollups.find((r) => r.team_id === 'team-alpha');
    expect(alpha?.reserved).toBe(800); // only the live run's reserved
  });

  it('sums spentEstimate for ALL runs in the team', () => {
    const runs = [
      makeRun({ run_id: 'run-live', team_id: 'team-alpha', state: 'live', budget_spent_estimate: 300 }),
      makeRun({ run_id: 'run-done', team_id: 'team-alpha', state: 'done', budget_spent_estimate: 700 }),
    ];
    const rollups = computeRollups(runs, []);
    const alpha = rollups.find((r) => r.team_id === 'team-alpha');
    expect(alpha?.spentEstimate).toBe(1000);
  });

  it('merges cancel_generation from teams array', () => {
    const runs = [makeRun({ team_id: 'team-alpha' })];
    const teams = [makeTeam({ team_id: 'team-alpha', cancel_generation: 3, last_cancel_at: '2026-06-25T00:00:00Z' })];
    const rollups = computeRollups(runs, teams);
    const alpha = rollups.find((r) => r.team_id === 'team-alpha');
    expect(alpha?.cancel_generation).toBe(3);
    expect(alpha?.last_cancel_at).toBe('2026-06-25T00:00:00Z');
  });

  it('places runs with no team_id in sentinel bucket (team_id="")', () => {
    const runs = [makeRun({ run_id: 'run-orphan', team_id: null })];
    const rollups = computeRollups(runs, []);
    expect(rollups).toHaveLength(1);
    expect(rollups[0].team_id).toBe('');
    expect(rollups[0].runs[0].run_id).toBe('run-orphan');
  });

  it('handles null budget values gracefully (treats as 0)', () => {
    const runs = [
      makeRun({ run_id: 'run-null', team_id: 'team-alpha', state: 'live', budget_reserved: null, budget_spent_estimate: null }),
    ];
    const rollups = computeRollups(runs, []);
    const alpha = rollups.find((r) => r.team_id === 'team-alpha');
    expect(alpha?.reserved).toBe(0);
    expect(alpha?.spentEstimate).toBe(0);
  });
});

// ---- SSE dedup / prepend / update state logic ----
// Tests the state-update patterns used in DispatchesView directly.
// (Mirrors the logic verbatim — verified without rendering the component.)

describe('SSE run state-update patterns', () => {
  function applyRunEvent(prev: RunRow[], incoming: RunRow): RunRow[] {
    const idx = prev.findIndex((r) => r.run_id === incoming.run_id);
    if (idx >= 0) {
      const next = [...prev];
      next[idx] = incoming;
      return next;
    }
    return [incoming, ...prev];
  }

  it('prepends a new run not yet in the list', () => {
    const existing = [makeRun({ run_id: 'run-1' })];
    const incoming = makeRun({ run_id: 'run-2', state: 'dispatching' });
    const result = applyRunEvent(existing, incoming);
    expect(result).toHaveLength(2);
    expect(result[0].run_id).toBe('run-2'); // prepended
    expect(result[1].run_id).toBe('run-1');
  });

  it('updates in place when run_id already exists — no duplicate', () => {
    const existing = [makeRun({ run_id: 'run-1', state: 'pending' })];
    const incoming = makeRun({ run_id: 'run-1', state: 'live' });
    const result = applyRunEvent(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0].state).toBe('live');
  });

  it('preserves order of other entries when updating', () => {
    const existing = [
      makeRun({ run_id: 'run-1' }),
      makeRun({ run_id: 'run-2' }),
      makeRun({ run_id: 'run-3' }),
    ];
    const incoming = makeRun({ run_id: 'run-2', state: 'done' });
    const result = applyRunEvent(existing, incoming);
    expect(result.map((r) => r.run_id)).toEqual(['run-1', 'run-2', 'run-3']);
    expect(result[1].state).toBe('done');
  });
});

describe('SSE team state-update patterns', () => {
  function applyTeamEvent(prev: TeamRow[], incoming: TeamRow): TeamRow[] {
    const idx = prev.findIndex((t) => t.team_id === incoming.team_id);
    if (idx >= 0) {
      const next = [...prev];
      next[idx] = incoming;
      return next;
    }
    return [incoming, ...prev];
  }

  it('prepends a new team not yet in the list', () => {
    const existing = [makeTeam({ team_id: 'team-alpha' })];
    const incoming = makeTeam({ team_id: 'team-beta' });
    const result = applyTeamEvent(existing, incoming);
    expect(result).toHaveLength(2);
    expect(result[0].team_id).toBe('team-beta');
  });

  it('updates a team record in place when team_id matches — no duplicate', () => {
    const existing = [makeTeam({ team_id: 'team-alpha', cancel_generation: 0 })];
    const incoming = makeTeam({ team_id: 'team-alpha', cancel_generation: 1, last_cancel_at: '2026-06-25T00:00:00Z' });
    const result = applyTeamEvent(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0].cancel_generation).toBe(1);
    expect(result[0].last_cancel_at).toBe('2026-06-25T00:00:00Z');
  });
});
