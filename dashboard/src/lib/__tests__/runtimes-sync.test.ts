/**
 * N3 Phase 2 contract: state/runtimes/*.json → SQLite upsert + SSE emission.
 *
 * Exercises syncFile() routing (→ syncRuntime) and the getRuntimes()/getRuntimeTree()
 * accessors. SSE emission is verified via the onSSEEvent subscription on the watcher
 * emitter; sync.ts is NOT mocked here (we want real SQLite writes). Following the
 * pattern from sync.test.ts: CTX_ROOT set before module import, dynamic imports in
 * beforeAll.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { RuntimeBoundaryRecord, SSEEvent } from '@/lib/types';

// Set CTX_ROOT before any module loads
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n3-sync-'));
process.env.CTX_ROOT = tmpDir;

// Dynamic imports so CTX_ROOT is wired before config.ts evaluates
let db: typeof import('../db')['db'];
let syncFile: typeof import('../sync')['syncFile'];
let syncAll: typeof import('../sync')['syncAll'];
let syncRuntime: typeof import('../sync')['syncRuntime'];
let getRuntimes: typeof import('../data/runtimes')['getRuntimes'];
let getRuntimeTree: typeof import('../data/runtimes')['getRuntimeTree'];
let handleFileChange: typeof import('../watcher')['handleFileChange'];
let onSSEEvent: typeof import('../watcher')['onSSEEvent'];

const RUNTIMES_DIR = path.join(tmpDir, 'state', 'runtimes');

const FIXTURE: RuntimeBoundaryRecord = {
  run_id: 'run-abc123',
  runtime: 'claude-bg',
  state: 'working',
  tree: [
    {
      id: 'agent-1',
      label: 'root',
      state: 'working',
      children: [],
      degraded: false,
    },
  ],
  degraded: false,
  updated_at: '2026-06-21T10:05:00Z',
};

function writeRuntime(record: RuntimeBoundaryRecord): string {
  fs.mkdirSync(RUNTIMES_DIR, { recursive: true });
  const fp = path.join(RUNTIMES_DIR, `${record.run_id}.json`);
  fs.writeFileSync(fp, JSON.stringify(record));
  return fp;
}

function clearTable(table: string): void {
  db.prepare(`DELETE FROM ${table}`).run();
}

function captureSSE(run: () => void): SSEEvent | undefined {
  let captured: SSEEvent | undefined;
  const unsub = onSSEEvent((e) => { captured = e; });
  try {
    run();
  } finally {
    unsub();
  }
  return captured;
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const dbMod = await import('../db');
  db = dbMod.db;

  const syncMod = await import('../sync');
  syncFile = syncMod.syncFile;
  syncAll = syncMod.syncAll;
  syncRuntime = syncMod.syncRuntime;

  const runtimesMod = await import('../data/runtimes');
  getRuntimes = runtimesMod.getRuntimes;
  getRuntimeTree = runtimesMod.getRuntimeTree;

  const watcherMod = await import('../watcher');
  handleFileChange = watcherMod.handleFileChange;
  onSSEEvent = watcherMod.onSSEEvent;
});

beforeEach(() => {
  clearTable('runtimes');
  clearTable('sync_meta');
  // Remove any leftover runtime files
  if (fs.existsSync(RUNTIMES_DIR)) {
    fs.readdirSync(RUNTIMES_DIR).forEach((f) =>
      fs.rmSync(path.join(RUNTIMES_DIR, f), { force: true }),
    );
  }
});

describe('syncRuntime', () => {
  it('upserts a runtime record into SQLite', () => {
    const fp = writeRuntime(FIXTURE);
    const ok = syncRuntime(fp);

    expect(ok).toBe(true);

    const rows = getRuntimes();
    expect(rows).toHaveLength(1);
    expect(rows[0].run_id).toBe('run-abc123');
    expect(rows[0].runtime).toBe('claude-bg');
    expect(rows[0].state).toBe('working');
    expect(rows[0].degraded).toBe(false);
    expect(rows[0].tree).toHaveLength(1);
    expect(rows[0].tree[0].id).toBe('agent-1');
  });

  it('skips unchanged files (mtime check)', () => {
    const fp = writeRuntime(FIXTURE);
    expect(syncRuntime(fp)).toBe(true);
    // Second call without file modification should skip
    expect(syncRuntime(fp)).toBe(false);
  });

  it('returns false for a missing file', () => {
    const result = syncRuntime(path.join(RUNTIMES_DIR, 'nonexistent.json'));
    expect(result).toBe(false);
  });
});

describe('syncFile routing', () => {
  it('routes state/runtimes/*.json to syncRuntime', () => {
    const fp = writeRuntime({ ...FIXTURE, run_id: 'run-routed' });

    syncFile(fp);

    const rows = getRuntimes();
    const row = rows.find((r) => r.run_id === 'run-routed');
    expect(row).toBeDefined();
  });
});

describe('syncAll runtime scanning', () => {
  it('picks up runtime files in state/runtimes/', () => {
    writeRuntime({ ...FIXTURE, run_id: 'run-all-1' });
    writeRuntime({ ...FIXTURE, run_id: 'run-all-2', state: 'done' });

    // Remove org dirs to avoid syncAll touching non-existent paths noisily
    const result = syncAll();

    expect(result.runtimes).toBe(2);
    expect(getRuntimes()).toHaveLength(2);
  });
});

describe('getRuntimeTree', () => {
  it('returns the parsed AgentNode[] for an existing run', () => {
    const fp = writeRuntime(FIXTURE);
    syncRuntime(fp);

    const tree = getRuntimeTree('run-abc123');
    expect(tree).not.toBeNull();
    expect(tree![0].id).toBe('agent-1');
    expect(tree![0].state).toBe('working');
  });

  it('returns null for an unknown run_id', () => {
    expect(getRuntimeTree('does-not-exist')).toBeNull();
  });
});

describe('SSE emission on runtime file change', () => {
  it('emits a "runtime" SSE event when handleFileChange processes a runtime file', () => {
    const fp = writeRuntime(FIXTURE);

    const event = captureSSE(() => handleFileChange(fp, 'add'));

    expect(event).toBeDefined();
    expect(event!.type).toBe('runtime');
    expect(event!.data.filePath).toBe(fp);
    expect(event!.data.changeType).toBe('add');
  });
});
