/**
 * N4 Phase A.1: getTeamRollups() per-team budget rollup contract.
 *
 * Verifies that:
 * - reserved = sum(budget_reserved) for LIVE_RUN_STATES only (dispatching, live, pending)
 * - spentEstimate = sum(budget_spent_estimate) for ALL runs in the team
 * - liveCount = count of runs with state IN LIVE_RUN_STATES
 * - failed / done / orphaned are excluded from reserved and liveCount
 * - cancel_generation is joined from the teams table
 * - ungrouped runs (no team_id) go into a sentinel bucket with team_id=''
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n4-rollup-'));
process.env.CTX_ROOT = tmpDir;

let db: typeof import('../db')['db'];
let getTeamRollups: typeof import('../data/dispatches')['getTeamRollups'];
let LIVE_RUN_STATES: typeof import('../data/dispatches')['LIVE_RUN_STATES'];

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const dbMod = await import('../db');
  db = dbMod.db;

  const dispatchesMod = await import('../data/dispatches');
  getTeamRollups = dispatchesMod.getTeamRollups;
  LIVE_RUN_STATES = dispatchesMod.LIVE_RUN_STATES;
});

beforeEach(() => {
  db.prepare('DELETE FROM runs').run();
  db.prepare('DELETE FROM teams').run();
});

function insertRun(
  run_id: string,
  team_id: string | null,
  state: string,
  budget_reserved: number,
  budget_spent_estimate: number,
): void {
  db.prepare(
    `INSERT INTO runs (run_id, team_id, state, budget_reserved, budget_spent_estimate, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(run_id, team_id, state, budget_reserved, budget_spent_estimate, new Date().toISOString());
}

function insertTeam(team_id: string, cancel_generation: number): void {
  db.prepare(
    `INSERT INTO teams (team_id, cancel_generation, updated_at) VALUES (?, ?, ?)`,
  ).run(team_id, cancel_generation, new Date().toISOString());
}

describe('getTeamRollups — budget rollup', () => {
  it('computes correct reserved / liveCount / spentEstimate for Team A and Team B', () => {
    // Team A: dispatching + live = live states; done = terminal
    insertRun('run-a1', 'team-a', 'dispatching', 100, 50);
    insertRun('run-a2', 'team-a', 'live', 200, 80);
    insertRun('run-a3', 'team-a', 'done', 300, 120);

    // Team B: pending = live state; failed + orphaned = terminal
    insertRun('run-b1', 'team-b', 'pending', 50, 10);
    insertRun('run-b2', 'team-b', 'failed', 0, 30);
    insertRun('run-b3', 'team-b', 'orphaned', 0, 20);

    insertTeam('team-a', 1);
    insertTeam('team-b', 4);

    const rollups = getTeamRollups();

    const teamA = rollups.find((r) => r.team_id === 'team-a');
    const teamB = rollups.find((r) => r.team_id === 'team-b');

    expect(teamA).toBeDefined();
    expect(teamB).toBeDefined();

    // Team A: only dispatching+live are reserved (done excluded)
    expect(teamA!.reserved).toBe(100 + 200); // 300
    expect(teamA!.liveCount).toBe(2);
    // spentEstimate includes ALL runs (dispatching + live + done)
    expect(teamA!.spentEstimate).toBe(50 + 80 + 120); // 250

    // Team B: only pending is reserved (failed+orphaned excluded)
    expect(teamB!.reserved).toBe(50);
    expect(teamB!.liveCount).toBe(1);
    // spentEstimate includes ALL runs
    expect(teamB!.spentEstimate).toBe(10 + 30 + 20); // 60
  });

  it('joins cancel_generation from the teams table', () => {
    insertRun('run-cg1', 'team-cg', 'live', 100, 50);
    insertTeam('team-cg', 7);

    const rollups = getTeamRollups();
    const teamCG = rollups.find((r) => r.team_id === 'team-cg');

    expect(teamCG!.cancel_generation).toBe(7);
  });

  it('defaults cancel_generation to 0 when team has no teams-table record', () => {
    insertRun('run-nk1', 'team-no-key', 'live', 100, 50);
    // No insertTeam for 'team-no-key'

    const rollups = getTeamRollups();
    const teamNK = rollups.find((r) => r.team_id === 'team-no-key');

    expect(teamNK!.cancel_generation).toBe(0);
    expect(teamNK!.last_cancel_at).toBeNull();
  });

  it('excludes done/failed/orphaned from reserved and liveCount', () => {
    insertRun('run-t1', 'team-t', 'done', 500, 500);
    insertRun('run-t2', 'team-t', 'failed', 500, 100);
    insertRun('run-t3', 'team-t', 'orphaned', 500, 200);

    const rollups = getTeamRollups();
    const teamT = rollups.find((r) => r.team_id === 'team-t');

    expect(teamT!.reserved).toBe(0);
    expect(teamT!.liveCount).toBe(0);
    // spentEstimate still includes all
    expect(teamT!.spentEstimate).toBe(800);
  });

  it('LIVE_RUN_STATES export is correct', () => {
    expect(LIVE_RUN_STATES).toContain('dispatching');
    expect(LIVE_RUN_STATES).toContain('live');
    expect(LIVE_RUN_STATES).toContain('pending');
    expect((LIVE_RUN_STATES as readonly string[]).includes('done')).toBe(false);
    expect((LIVE_RUN_STATES as readonly string[]).includes('failed')).toBe(false);
    expect((LIVE_RUN_STATES as readonly string[]).includes('orphaned')).toBe(false);
  });
});

describe('getTeamRollups — ungrouped sentinel bucket', () => {
  it('collects runs with no team_id into team_id="" bucket', () => {
    insertRun('run-ug1', null, 'live', 100, 40);
    insertRun('run-ug2', null, 'done', 200, 80);

    const rollups = getTeamRollups();
    const ungrouped = rollups.find((r) => r.team_id === '');

    expect(ungrouped).toBeDefined();
    expect(ungrouped!.liveCount).toBe(1); // only 'live'
    expect(ungrouped!.reserved).toBe(100); // only live run
    expect(ungrouped!.spentEstimate).toBe(40 + 80); // all runs
    expect(ungrouped!.runs).toHaveLength(2);
  });

  it('does not create a sentinel bucket when all runs have team_ids', () => {
    insertRun('run-grp1', 'team-grp', 'live', 100, 50);

    const rollups = getTeamRollups();

    expect(rollups.find((r) => r.team_id === '')).toBeUndefined();
  });
});

describe('getTeamRollups — edge cases', () => {
  it('returns empty array when no runs exist', () => {
    const rollups = getTeamRollups();
    expect(rollups).toHaveLength(0);
  });

  it('handles null budget_reserved/budget_spent_estimate gracefully (treats as 0)', () => {
    db.prepare(
      `INSERT INTO runs (run_id, team_id, state, budget_reserved, budget_spent_estimate, updated_at)
       VALUES ('run-null', 'team-null', 'live', NULL, NULL, ?)`,
    ).run(new Date().toISOString());

    const rollups = getTeamRollups();
    const teamNull = rollups.find((r) => r.team_id === 'team-null');

    expect(teamNull!.reserved).toBe(0);
    expect(teamNull!.spentEstimate).toBe(0);
  });
});
