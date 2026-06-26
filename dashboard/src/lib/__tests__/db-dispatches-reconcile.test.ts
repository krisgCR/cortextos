/**
 * N4 Phase A.1 regression guard: runs + teams cache-table schema reconcile (db.ts).
 *
 * Seeds stale schemas for both tables, then asserts that importing db.ts self-heals
 * by dropping and recreating them with the correct columns. Mirrors the pattern from
 * db-runtimes-reconcile.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'n4-reconcile-')));
const dbPath = path.join(tmp, 'dashboard', 'cortextos-default.db');

beforeAll(() => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Seed STALE schemas for both runs and teams.
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      state TEXT,
      old_column_1 TEXT,
      old_column_2 INTEGER
    );
  `);
  seed.prepare(`INSERT INTO runs (run_id, state) VALUES ('stale-run-1', 'live')`).run();

  seed.exec(`
    CREATE TABLE teams (
      team_id TEXT PRIMARY KEY,
      stale_counter INTEGER
    );
  `);
  seed.prepare(`INSERT INTO teams (team_id, stale_counter) VALUES ('stale-team-1', 99)`).run();
  seed.close();

  // db.ts reads process.env.CTX_ROOT at import time — set before the dynamic import.
  process.env.CTX_ROOT = tmp;
  process.env.CTX_INSTANCE_ID = 'default';
});

describe('runs schema reconcile (db.ts)', () => {
  it('drops + recreates a stale runs table on open, then accepts N4 inserts', async () => {
    const { db } = await import('../db');

    const cols = (db.pragma('table_info(runs)') as { name: string }[]).map(
      (c) => c.name,
    );

    // New columns present
    expect(cols).toContain('budget_reserved');
    expect(cols).toContain('budget_spent_estimate');
    expect(cols).toContain('cancel_generation');
    expect(cols).toContain('team_id');
    expect(cols).toContain('epoch');
    expect(cols).toContain('heartbeat');

    // Stale columns gone
    expect(cols).not.toContain('old_column_1');
    expect(cols).not.toContain('old_column_2');

    // Stale row dropped (cache is rebuilt from disk by syncAll)
    const count = (db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c;
    expect(count).toBe(0);

    // The exact INSERT shape syncRun() uses now succeeds
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO runs
            (run_id, team_id, state, lane, native_id, budget_reserved,
             budget_spent_estimate, cancel_generation, epoch, heartbeat, updated_at)
           VALUES
            (@run_id, @team_id, @state, @lane, @native_id, @budget_reserved,
             @budget_spent_estimate, @cancel_generation, @epoch, @heartbeat, @updated_at)`,
        )
        .run({
          run_id: 'n4-smoke-001',
          team_id: 'team-alpha',
          state: 'live',
          lane: 'claude-bg',
          native_id: null,
          budget_reserved: 100,
          budget_spent_estimate: 50,
          cancel_generation: 0,
          epoch: 1,
          heartbeat: '2026-06-25T10:00:00Z',
          updated_at: '2026-06-25T10:00:00Z',
        }),
    ).not.toThrow();
  });
});

describe('teams schema reconcile (db.ts)', () => {
  it('drops + recreates a stale teams table on open, then accepts N4 inserts', async () => {
    const { db } = await import('../db');

    const cols = (db.pragma('table_info(teams)') as { name: string }[]).map(
      (c) => c.name,
    );

    // New columns present
    expect(cols).toContain('team_id');
    expect(cols).toContain('cancel_generation');
    expect(cols).toContain('last_cancel_at');
    expect(cols).toContain('updated_at');

    // Stale column gone
    expect(cols).not.toContain('stale_counter');

    // Stale row dropped
    const count = (db.prepare('SELECT COUNT(*) AS c FROM teams').get() as { c: number }).c;
    expect(count).toBe(0);

    // The exact INSERT shape syncTeam() uses now succeeds
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO teams
            (team_id, cancel_generation, last_cancel_at, updated_at)
           VALUES
            (@team_id, @cancel_generation, @last_cancel_at, @updated_at)`,
        )
        .run({
          team_id: 'team-smoke-001',
          cancel_generation: 3,
          last_cancel_at: '2026-06-25T08:00:00Z',
          updated_at: '2026-06-25T10:00:00Z',
        }),
    ).not.toThrow();
  });
});
