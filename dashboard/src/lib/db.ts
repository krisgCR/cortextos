// cortextOS Dashboard - SQLite database singleton
// Read cache for JSON/JSONL files on disk. WAL mode for concurrent reads.

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
const ctxRoot = process.env.CTX_ROOT;
const DB_PATH = ctxRoot
  ? path.join(ctxRoot, 'dashboard', `cortextos-${instanceId}.db`)
  : path.join(process.cwd(), '.data', `cortextos-${instanceId}.db`);

function createDatabase(): Database.Database {
  // Ensure .data directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(DB_PATH, { timeout: 10000 });

  // Set busy_timeout BEFORE attempting any schema or pragma changes that
  // require write locks (e.g. WAL switch, CREATE TABLE). Without this, parallel
  // processes (like Next.js build workers) hit SQLITE_BUSY immediately.
  db.pragma('busy_timeout = 10000');

  // Switch to WAL mode (requires exclusive lock on the DB file).
  // Guard against SQLITE_BUSY when multiple Next.js build workers open the DB
  // simultaneously: if the switch fails, check whether another worker already
  // succeeded. If so, continue; otherwise re-throw.
  try {
    db.pragma('journal_mode = WAL');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException & { code?: string }).code !== 'SQLITE_BUSY') throw err;
    const rows = db.pragma('journal_mode') as { journal_mode: string }[];
    if (rows[0]?.journal_mode !== 'wal') throw err;
    // Another worker already switched to WAL — we're fine.
  }
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Run schema initialization
  initializeSchema(db);

  return db;
}

// The `runtimes` table schema evolved during N3 development (native_id/cwd added,
// started_at/observed_at removed). `CREATE TABLE IF NOT EXISTS` does NOT migrate an
// existing table, so a DB created by an earlier N3 build keeps the stale shape and
// every runtime sync fails ("table runtimes has no column named native_id"). Because
// this table is a rebuildable read-cache of state/runtimes/*.json, the safe, self-
// healing fix is to drop it on column drift and let the CREATE below recreate it;
// syncAll() re-ingests the records from disk on the next watcher init.
function reconcileRuntimesSchema(db: Database.Database): void {
  const cols = (db.pragma('table_info(runtimes)') as { name: string }[]).map(
    (c) => c.name,
  );
  if (cols.length === 0) return; // table doesn't exist yet — CREATE handles it
  // Keep in sync with the CREATE TABLE runtimes statement below.
  const expected = [
    'run_id',
    'runtime',
    'state',
    'tree',
    'degraded',
    'updated_at',
    'native_id',
    'cwd',
  ];
  const matches =
    cols.length === expected.length && expected.every((c) => cols.includes(c));
  if (!matches) {
    // Dropping is safe: the data is a cache rebuilt from disk by syncAll().
    db.exec('DROP TABLE IF EXISTS runtimes;');
  }
}

// Runs table drift-reconcile: mirrors reconcileRuntimesSchema for the N4 runs cache.
// Safe to drop — data is rebuilt from state/runs/*.json by syncAll().
function reconcileRunsSchema(db: Database.Database): void {
  const cols = (db.pragma('table_info(runs)') as { name: string }[]).map(
    (c) => c.name,
  );
  if (cols.length === 0) return; // table doesn't exist yet — CREATE handles it
  const expected = [
    'run_id',
    'team_id',
    'state',
    'lane',
    'native_id',
    'budget_reserved',
    'budget_spent_estimate',
    'cancel_generation',
    'epoch',
    'heartbeat',
    'updated_at',
  ];
  const matches =
    cols.length === expected.length && expected.every((c) => cols.includes(c));
  if (!matches) {
    db.exec('DROP TABLE IF EXISTS runs;');
  }
}

// Teams table drift-reconcile.
function reconcileTeamsSchema(db: Database.Database): void {
  const cols = (db.pragma('table_info(teams)') as { name: string }[]).map(
    (c) => c.name,
  );
  if (cols.length === 0) return;
  const expected = ['team_id', 'cancel_generation', 'last_cancel_at', 'updated_at'];
  const matches =
    cols.length === expected.length && expected.every((c) => cols.includes(c));
  if (!matches) {
    db.exec('DROP TABLE IF EXISTS teams;');
  }
}

function initializeSchema(db: Database.Database): void {
  // Reconcile drifted cache-table schemas before the idempotent CREATEs below.
  reconcileRuntimesSchema(db);
  reconcileRunsSchema(db);
  reconcileTeamsSchema(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'normal',
      assignee TEXT,
      org TEXT NOT NULL DEFAULT '',
      project TEXT,
      needs_approval INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      completed_at TEXT,
      notes TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_note TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      category TEXT,
      severity TEXT NOT NULL DEFAULT 'info',
      data TEXT,
      message TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS heartbeats (
      agent TEXT PRIMARY KEY,
      org TEXT NOT NULL DEFAULT '',
      status TEXT,
      current_task TEXT,
      mode TEXT,
      last_heartbeat TEXT,
      loop_interval INTEGER,
      uptime_seconds INTEGER
    );

    CREATE TABLE IF NOT EXISTS cost_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      file_path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      last_synced TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Rate limit table: persists across server restarts so limits survive hot-reloads
    -- and intentional restarts. reset_at is a Unix timestamp in milliseconds.
    CREATE TABLE IF NOT EXISTS rate_limits (
      ip TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      reset_at INTEGER NOT NULL
    );

    -- Runtime boundary records (N3 dashboard federation)
    -- Shape mirrors src/types/index.ts RuntimeBoundaryRecord (no cross-workspace import).
    CREATE TABLE IF NOT EXISTS runtimes (
      run_id TEXT PRIMARY KEY,
      runtime TEXT NOT NULL,
      state TEXT NOT NULL,
      tree TEXT NOT NULL,
      degraded INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      native_id TEXT,
      cwd TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runtimes_state ON runtimes(state);
    CREATE INDEX IF NOT EXISTS idx_runtimes_runtime ON runtimes(runtime);
    CREATE INDEX IF NOT EXISTS idx_runtimes_updated_at ON runtimes(updated_at);

    -- N4 dispatch run ledger (state/runs/<run_id>.json cache)
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      team_id TEXT,
      state TEXT,
      lane TEXT,
      native_id TEXT,
      budget_reserved INTEGER,
      budget_spent_estimate INTEGER,
      cancel_generation INTEGER,
      epoch INTEGER,
      heartbeat TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_team_id ON runs(team_id);
    CREATE INDEX IF NOT EXISTS idx_runs_updated_at ON runs(updated_at);

    -- N4 team cancel-generation ledger (state/teams/<team_id>.json cache)
    CREATE TABLE IF NOT EXISTS teams (
      team_id TEXT PRIMARY KEY,
      cancel_generation INTEGER NOT NULL DEFAULT 0,
      last_cancel_at TEXT,
      updated_at TEXT
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

    CREATE INDEX IF NOT EXISTS idx_approvals_org ON approvals(org);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent);

    CREATE INDEX IF NOT EXISTS idx_events_org ON events(org);
    CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);

    CREATE INDEX IF NOT EXISTS idx_cost_entries_timestamp ON cost_entries(timestamp);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_agent ON cost_entries(agent);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_org ON cost_entries(org);

    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_org ON messages(org);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  `);
}

// globalThis singleton survives Next.js hot reload
const globalForDb = globalThis as unknown as {
  __cortextos_db: Database.Database | undefined;
};

export const db = globalForDb.__cortextos_db ?? createDatabase();

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__cortextos_db = db;
}

/** Re-export for explicit initialization (idempotent - db is created on import) */
export function initializeDb(): Database.Database {
  return db;
}

/** Check if the database connection is healthy */
export function isDatabaseReady(): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

/** Get row counts for all tables (useful for diagnostics) */
export function getTableCounts(): Record<string, number> {
  const tables = [
    'tasks',
    'approvals',
    'events',
    'heartbeats',
    'cost_entries',
    'users',
    'messages',
    'sync_meta',
    'runtimes',
    'runs',
    'teams',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as {
      count: number;
    };
    counts[table] = row.count;
  }
  return counts;
}

export default db;
