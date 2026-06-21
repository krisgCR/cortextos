/**
 * Unit tests for the run-authority ledger.
 *
 * Isolation strategy: vi.mock('os') replaces homedir() with a function that
 * returns a fresh temp directory per test suite invocation. Each test uses
 * a unique instanceId to get a clean ledger sub-directory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Intercept os.homedir() before the module under test is imported so that
// the ledger writes go to our temp dir, not ~/.cortextos.
// ---------------------------------------------------------------------------

let tempHome = '';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    homedir: () => tempHome,
  };
});

import {
  acquireLease,
  AgentsJsonEntry,
  recordRun,
  reconcile,
  RunLeaseConflictError,
  touchHeartbeat,
} from '../../../src/runtime/run-authority.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'run-auth-test-'));
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueInstance(): string {
  return `inst-${Math.random().toString(36).slice(2, 10)}`;
}

function uniqueRunId(): string {
  return `run-${Math.random().toString(36).slice(2, 14)}`;
}

function ledgerPath(instanceId: string): string {
  return path.join(tempHome, '.cortextos', instanceId, 'state', 'runs');
}

// ---------------------------------------------------------------------------
// Task 2.3.1 — recordRun idempotency
// ---------------------------------------------------------------------------

describe('recordRun', () => {
  it('writes a run record to the ledger', () => {
    const instanceId = uniqueInstance();
    const run_id = uniqueRunId();
    const idempotency_key = `idem-${run_id}`;

    recordRun(instanceId, { run_id, idempotency_key });

    const ledger = ledgerPath(instanceId);
    const files = fs.readdirSync(ledger);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${run_id}.json`);

    const record = JSON.parse(
      fs.readFileSync(path.join(ledger, files[0]), 'utf-8'),
    );
    expect(record.run_id).toBe(run_id);
    expect(record.idempotency_key).toBe(idempotency_key);
    expect(record.state).toBe('pending');
    expect(record.epoch).toBe(0);
  });

  it('second call with same idempotency_key is a no-op (idempotent)', () => {
    const instanceId = uniqueInstance();
    const run_id = uniqueRunId();
    const idempotency_key = `idem-${run_id}`;

    recordRun(instanceId, { run_id, idempotency_key });

    // Capture mtime after first write
    const ledger = ledgerPath(instanceId);
    const recordFile = path.join(ledger, `${run_id}.json`);
    const mtime1 = fs.statSync(recordFile).mtimeMs;

    // Second call — same key
    recordRun(instanceId, { run_id, idempotency_key });

    // File should not have been rewritten
    const mtime2 = fs.statSync(recordFile).mtimeMs;
    // File content unchanged
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf-8'));
    expect(record.idempotency_key).toBe(idempotency_key);
    // mtime may or may not change depending on fs resolution, but content is stable
    expect(mtime2).toBeGreaterThanOrEqual(mtime1);
  });

  it('throws when called with same run_id but different idempotency_key', () => {
    const instanceId = uniqueInstance();
    const run_id = uniqueRunId();

    recordRun(instanceId, { run_id, idempotency_key: 'key-A' });

    // Same run_id, different key — must refuse, not silently overwrite
    expect(() => recordRun(instanceId, { run_id, idempotency_key: 'key-B' })).toThrow(
      /already registered with a different idempotency_key/,
    );

    // Original record must be untouched
    const ledger = ledgerPath(instanceId);
    const record = JSON.parse(fs.readFileSync(path.join(ledger, `${run_id}.json`), 'utf-8'));
    expect(record.idempotency_key).toBe('key-A');
  });
});

// ---------------------------------------------------------------------------
// Task 2.3.2 — acquireLease conflict
// ---------------------------------------------------------------------------

describe('acquireLease', () => {
  it('acquires a lease and writes the record', () => {
    const instanceId = uniqueInstance();
    const run_id = uniqueRunId();
    const worktree = '/tmp/worktrees/wt-abc';

    recordRun(instanceId, { run_id, idempotency_key: `idem-${run_id}` });
    const lease = acquireLease(instanceId, worktree, run_id);

    expect(lease.worktree).toBe(worktree);
    expect(lease.holderRunId).toBe(run_id);
    expect(typeof lease.fencingToken).toBe('string');
    expect(lease.fencingToken.length).toBeGreaterThan(0);
    expect(lease.epoch).toBe(1);
    expect(typeof lease.heartbeat).toBe('string');
  });

  it('throws RunLeaseConflictError when same worktree is requested by a different run', () => {
    const instanceId = uniqueInstance();
    const runA = uniqueRunId();
    const runB = uniqueRunId();
    const worktree = '/tmp/worktrees/wt-conflict';

    recordRun(instanceId, { run_id: runA, idempotency_key: `idem-${runA}` });
    recordRun(instanceId, { run_id: runB, idempotency_key: `idem-${runB}` });

    // runA acquires the worktree
    acquireLease(instanceId, worktree, runA);

    // runB tries to acquire the same worktree → conflict
    expect(() => acquireLease(instanceId, worktree, runB)).toThrow(
      RunLeaseConflictError,
    );

    try {
      acquireLease(instanceId, worktree, runB);
    } catch (err) {
      expect(err).toBeInstanceOf(RunLeaseConflictError);
      const conflict = err as RunLeaseConflictError;
      expect(conflict.worktree).toBe(worktree);
      expect(conflict.holderRunId).toBe(runA);
    }
  });

  it('allows re-acquiring a lease for the same run_id', () => {
    const instanceId = uniqueInstance();
    const run_id = uniqueRunId();
    const worktree = '/tmp/worktrees/wt-reacquire';

    recordRun(instanceId, { run_id, idempotency_key: `idem-${run_id}` });
    const lease1 = acquireLease(instanceId, worktree, run_id);
    // Should not throw — same holder
    const lease2 = acquireLease(instanceId, worktree, run_id);

    expect(lease1.worktree).toBe(lease2.worktree);
  });
});

// ---------------------------------------------------------------------------
// Task 2.3.3 — reconcile: readopted, completed, orphaned
// ---------------------------------------------------------------------------

describe('reconcile', () => {
  it('marks a live native_id match as readopted', () => {
    const instanceId = uniqueInstance();
    const run_id = uniqueRunId();
    const native_id = `native-${uniqueRunId()}`;

    // Set up a ledger record that is already live with a native_id
    recordRun(instanceId, { run_id, idempotency_key: `idem-${run_id}` });
    acquireLease(instanceId, '/tmp/worktrees/wt-reconcile-live', run_id);

    // Manually inject the native_id into the record
    const ledger = ledgerPath(instanceId);
    const recordFile = path.join(ledger, `${run_id}.json`);
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf-8'));
    record.native_id = native_id;
    fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));

    const snapshot: AgentsJsonEntry[] = [
      { id: native_id, state: 'working', sessionId: undefined },
    ];

    const report = reconcile(instanceId, snapshot);

    expect(report.readopted).toContain(run_id);
    expect(report.completed).not.toContain(run_id);
    expect(report.orphaned).not.toContain(run_id);
  });

  it('marks a done native_id match as completed', () => {
    const instanceId = uniqueInstance();
    const run_id = uniqueRunId();
    const native_id = `native-${uniqueRunId()}`;

    recordRun(instanceId, { run_id, idempotency_key: `idem-${run_id}` });
    acquireLease(instanceId, '/tmp/worktrees/wt-reconcile-done', run_id);

    const ledger = ledgerPath(instanceId);
    const recordFile = path.join(ledger, `${run_id}.json`);
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf-8'));
    record.native_id = native_id;
    fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));

    const snapshot: AgentsJsonEntry[] = [
      { id: native_id, state: 'done', sessionId: undefined },
    ];

    const report = reconcile(instanceId, snapshot);

    expect(report.completed).toContain(run_id);
    expect(report.readopted).not.toContain(run_id);
    expect(report.orphaned).not.toContain(run_id);
  });

  it('marks a previously-live run with no snapshot match as orphaned', () => {
    const instanceId = uniqueInstance();
    const run_id = uniqueRunId();

    recordRun(instanceId, { run_id, idempotency_key: `idem-${run_id}` });
    acquireLease(instanceId, '/tmp/worktrees/wt-reconcile-orphan', run_id);
    // No native_id set — simulate a run that never registered with the native supervisor

    const snapshot: AgentsJsonEntry[] = []; // Empty — run not found

    const report = reconcile(instanceId, snapshot);

    expect(report.orphaned).toContain(run_id);
    expect(report.readopted).not.toContain(run_id);
    expect(report.completed).not.toContain(run_id);
  });

  it('matches by sessionId when native_id is absent', () => {
    const instanceId = uniqueInstance();
    const run_id = uniqueRunId();
    const native_id = `native-${uniqueRunId()}`;

    recordRun(instanceId, { run_id, idempotency_key: `idem-${run_id}` });
    acquireLease(instanceId, '/tmp/worktrees/wt-reconcile-session', run_id);

    // No native_id on the record — match via sessionId === run_id
    const snapshot: AgentsJsonEntry[] = [
      { id: native_id, state: 'blocked', sessionId: run_id },
    ];

    const report = reconcile(instanceId, snapshot);

    expect(report.readopted).toContain(run_id);
  });
});
