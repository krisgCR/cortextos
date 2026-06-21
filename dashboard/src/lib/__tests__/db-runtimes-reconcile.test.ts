/**
 * Regression guard for the runtimes cache-table schema reconcile (db.ts).
 *
 * An earlier N3 build created the `runtimes` table with a different shape
 * (started_at/observed_at, no native_id/cwd). `CREATE TABLE IF NOT EXISTS` does not
 * migrate it, so every runtime sync failed ("table runtimes has no column named
 * native_id"). db.ts now detects column drift on open and drops+recreates the table
 * (safe — it's a rebuildable cache of state/runtimes/*.json). This test seeds the
 * stale schema, then asserts importing db.ts heals it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'n3-reconcile-')));
const dbPath = path.join(tmp, 'dashboard', `cortextos-default.db`);

beforeAll(() => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Seed the STALE table shape + a row (the earlier N3 iteration).
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runtimes (
      run_id TEXT PRIMARY KEY,
      runtime TEXT NOT NULL,
      state TEXT NOT NULL,
      tree TEXT NOT NULL,
      degraded INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      observed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  seed
    .prepare(
      `INSERT INTO runtimes (run_id, runtime, state, tree, degraded, started_at, observed_at, updated_at)
       VALUES ('stale-1','claude','running','[]',0,'t','t','t')`,
    )
    .run();
  seed.close();

  // db.ts reads process.env.CTX_ROOT at import time — set before the dynamic import.
  process.env.CTX_ROOT = tmp;
  process.env.CTX_INSTANCE_ID = 'default';
});

describe('runtimes schema reconcile (db.ts)', () => {
  it('drops + recreates a stale runtimes table on open, then accepts the N3 insert', async () => {
    const { db } = await import('../db'); // createDatabase() -> reconcileRuntimesSchema()

    const cols = (db.pragma('table_info(runtimes)') as { name: string }[]).map(
      (c) => c.name,
    );
    // New columns present, stale columns gone.
    expect(cols).toContain('native_id');
    expect(cols).toContain('cwd');
    expect(cols).not.toContain('started_at');
    expect(cols).not.toContain('observed_at');

    // Stale row dropped (cache is rebuilt from disk by syncAll, not preserved here).
    const count = (db.prepare('SELECT COUNT(*) AS c FROM runtimes').get() as {
      c: number;
    }).c;
    expect(count).toBe(0);

    // The exact INSERT shape sync.ts uses now succeeds (the original failure mode).
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO runtimes
             (run_id, runtime, state, tree, degraded, updated_at, native_id, cwd)
           VALUES (@run_id, @runtime, @state, @tree, @degraded, @updated_at, @native_id, @cwd)`,
        )
        .run({
          run_id: 'n3-smoke-001',
          runtime: 'claude',
          state: 'running',
          tree: '[]',
          degraded: 0,
          updated_at: 't',
          native_id: null,
          cwd: null,
        }),
    ).not.toThrow();
  });
});
