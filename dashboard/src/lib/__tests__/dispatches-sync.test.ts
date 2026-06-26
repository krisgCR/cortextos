/**
 * N4 Phase A.1 contract: state/runs/*.json + state/teams/*.json → SQLite upsert.
 *
 * Exercises syncRun() / syncTeam() and syncFile() routing, plus syncAll() scanning.
 * Follows the pattern from runtimes-sync.test.ts: CTX_ROOT set before module import,
 * dynamic imports in beforeAll. Real SQLite writes — sync.ts is NOT mocked.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { RunRow, TeamRow } from '@/lib/types';

// Set CTX_ROOT before any module loads
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n4-sync-'));
process.env.CTX_ROOT = tmpDir;

let db: typeof import('../db')['db'];
let syncRun: typeof import('../sync')['syncRun'];
let syncTeam: typeof import('../sync')['syncTeam'];
let syncFile: typeof import('../sync')['syncFile'];
let syncAll: typeof import('../sync')['syncAll'];
let getDispatches: typeof import('../data/dispatches')['getDispatches'];
let getTeams: typeof import('../data/dispatches')['getTeams'];

const RUNS_DIR = path.join(tmpDir, 'state', 'runs');
const TEAMS_DIR = path.join(tmpDir, 'state', 'teams');

const RUN_FIXTURE: RunRow = {
  run_id: 'run-n4-001',
  team_id: 'team-alpha',
  state: 'live',
  lane: 'claude-bg',
  native_id: 'bg-native-abc',
  budget_reserved: 200,
  budget_spent_estimate: 50,
  cancel_generation: 0,
  epoch: 1,
  heartbeat: '2026-06-25T10:00:00Z',
  updated_at: '2026-06-25T10:00:00Z',
};

const TEAM_FIXTURE = {
  team_id: 'team-alpha',
  cancel_generation: 2,
  last_cancel_at: '2026-06-24T08:00:00Z',
};

function writeRun(record: Record<string, unknown>): string {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const fp = path.join(RUNS_DIR, `${record.run_id}.json`);
  fs.writeFileSync(fp, JSON.stringify(record));
  return fp;
}

function writeTeam(record: Record<string, unknown>): string {
  fs.mkdirSync(TEAMS_DIR, { recursive: true });
  const fp = path.join(TEAMS_DIR, `${record.team_id}.json`);
  fs.writeFileSync(fp, JSON.stringify(record));
  return fp;
}

function clearTable(table: string): void {
  db.prepare(`DELETE FROM ${table}`).run();
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const dbMod = await import('../db');
  db = dbMod.db;

  const syncMod = await import('../sync');
  syncRun = syncMod.syncRun;
  syncTeam = syncMod.syncTeam;
  syncFile = syncMod.syncFile;
  syncAll = syncMod.syncAll;

  const dispatchesMod = await import('../data/dispatches');
  getDispatches = dispatchesMod.getDispatches;
  getTeams = dispatchesMod.getTeams;
});

beforeEach(() => {
  clearTable('runs');
  clearTable('teams');
  clearTable('sync_meta');
  // Remove leftover files
  for (const dir of [RUNS_DIR, TEAMS_DIR]) {
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).forEach((f) =>
        fs.rmSync(path.join(dir, f), { force: true }),
      );
    }
  }
});

describe('syncRun', () => {
  it('upserts a run record into SQLite', () => {
    const fp = writeRun(RUN_FIXTURE);
    const ok = syncRun(fp);

    expect(ok).toBe(true);

    const rows = getDispatches();
    expect(rows).toHaveLength(1);
    expect(rows[0].run_id).toBe('run-n4-001');
    expect(rows[0].team_id).toBe('team-alpha');
    expect(rows[0].state).toBe('live');
    expect(rows[0].lane).toBe('claude-bg');
    expect(rows[0].budget_reserved).toBe(200);
    expect(rows[0].budget_spent_estimate).toBe(50);
  });

  it('skips unchanged files (mtime check)', () => {
    const fp = writeRun(RUN_FIXTURE);
    expect(syncRun(fp)).toBe(true);
    // Second call without file modification should skip
    expect(syncRun(fp)).toBe(false);
  });

  it('returns false for a missing file', () => {
    const result = syncRun(path.join(RUNS_DIR, 'nonexistent.json'));
    expect(result).toBe(false);
  });

  it('handles null optional fields gracefully', () => {
    const fp = writeRun({ run_id: 'run-minimal', state: 'pending' });
    const ok = syncRun(fp);

    expect(ok).toBe(true);

    const rows = getDispatches();
    const row = rows.find((r) => r.run_id === 'run-minimal');
    expect(row).toBeDefined();
    expect(row!.team_id).toBeNull();
    expect(row!.lane).toBeNull();
    expect(row!.budget_reserved).toBeNull();
  });
});

describe('syncTeam', () => {
  it('upserts a team record into SQLite', () => {
    const fp = writeTeam(TEAM_FIXTURE);
    const ok = syncTeam(fp);

    expect(ok).toBe(true);

    const rows = getTeams();
    expect(rows).toHaveLength(1);
    expect(rows[0].team_id).toBe('team-alpha');
    expect(rows[0].cancel_generation).toBe(2);
    expect(rows[0].last_cancel_at).toBe('2026-06-24T08:00:00Z');
  });

  it('skips unchanged files (mtime check)', () => {
    const fp = writeTeam(TEAM_FIXTURE);
    expect(syncTeam(fp)).toBe(true);
    expect(syncTeam(fp)).toBe(false);
  });

  it('returns false for a missing file', () => {
    const result = syncTeam(path.join(TEAMS_DIR, 'nonexistent.json'));
    expect(result).toBe(false);
  });
});

describe('syncFile routing', () => {
  it('routes state/runs/*.json to syncRun', () => {
    const fp = writeRun({ ...RUN_FIXTURE, run_id: 'run-routed' });

    syncFile(fp);

    const rows = getDispatches();
    const row = rows.find((r) => r.run_id === 'run-routed');
    expect(row).toBeDefined();
  });

  it('routes state/teams/*.json to syncTeam', () => {
    const fp = writeTeam({ ...TEAM_FIXTURE, team_id: 'team-routed' });

    syncFile(fp);

    const rows = getTeams();
    const row = rows.find((t) => t.team_id === 'team-routed');
    expect(row).toBeDefined();
  });
});

describe('syncAll run and team scanning', () => {
  it('picks up run files in state/runs/', () => {
    writeRun({ ...RUN_FIXTURE, run_id: 'run-all-1' });
    writeRun({ ...RUN_FIXTURE, run_id: 'run-all-2', state: 'done' });

    const result = syncAll();

    expect(result.runs).toBe(2);
    expect(getDispatches()).toHaveLength(2);
  });

  it('picks up team files in state/teams/', () => {
    writeTeam({ ...TEAM_FIXTURE, team_id: 'team-all-1' });
    writeTeam({ ...TEAM_FIXTURE, team_id: 'team-all-2' });

    const result = syncAll();

    expect(result.teams).toBe(2);
    expect(getTeams()).toHaveLength(2);
  });
});
