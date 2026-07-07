/**
 * Unit tests for the Task 2.3 sticky-reconcile guard and the boot-time
 * termination escalation helper (`reissueTermination`) in run-authority.ts.
 *
 * Isolation strategy: vi.mock('os') replaces homedir() with a function that
 * returns a fresh temp directory per test. Each test uses a unique
 * instanceId to get a clean ledger sub-directory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempHome = '';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    homedir: () => tempHome,
  };
});

import {
  allRecords,
  reconcile,
  releaseDispatch,
  requestCancel,
  reserveDispatch,
  reissueTermination,
  touchHeartbeat,
  type AgentsJsonEntry,
} from '../../../src/runtime/run-authority.js';

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'run-auth-reconcile-sticky-'));
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function reserve(instanceId: string, runId: string) {
  return reserveDispatch(instanceId, {
    run_id: runId,
    idempotency_key: uid('idem'),
    lane: 'claude-bg',
    budget_tokens: 10,
    teamBudgetTokens: 10_000,
    maxConcurrency: 10,
  });
}

// ---------------------------------------------------------------------------
// reconcile — sticky guard
// ---------------------------------------------------------------------------

describe('reconcile — sticky guard (Task 2.3)', () => {
  it('a cancel decided just before a simulated crash (cancel_requested_at set, state still dispatching) is NOT re-adopted as live', () => {
    const instanceId = uid('inst');
    const runId = uid('run');

    const reserved = reserve(instanceId, runId);
    expect(reserved.ok).toBe(true);
    touchHeartbeat(instanceId, runId, 'native-1');
    // Cancel intent recorded; simulated crash happens BEFORE cancelRun's own
    // finalize/terminate step runs — state is still 'dispatching'.
    requestCancel(instanceId, runId, 'human');

    const preCrash = allRecords(instanceId).find((r) => r.run_id === runId);
    expect(preCrash?.state).toBe('dispatching');
    expect(preCrash?.cancel_requested_at).toBeDefined();

    // "Restart": the native supervisor still reports the session running
    // (nobody ever terminated it before the crash).
    const snapshot: AgentsJsonEntry[] = [{ id: 'native-1', state: 'working', sessionId: undefined }];
    const report = reconcile(instanceId, snapshot);

    expect(report.readopted).not.toContain(runId);
    expect(report.stickyLive).toContain(runId);

    const rec = allRecords(instanceId).find((r) => r.run_id === runId);
    // Not resurrected to 'live' — reconcile() itself never advances a sticky
    // record's state; it only flags it for termination escalation.
    expect(rec?.state).not.toBe('live');
    expect(rec?.cancel_reason).toBe('human');
  });

  it('a terminal-orphan record (state=orphaned, no cancel intent) whose native session still reports live is flagged sticky, not resurrected', () => {
    const instanceId = uid('inst');
    const runId = uid('run');

    const reserved = reserve(instanceId, runId);
    expect(reserved.ok).toBe(true);
    touchHeartbeat(instanceId, runId, 'native-1');
    releaseDispatch(instanceId, runId, 'failed'); // simulate an orphan-marking path landing 'failed'
    // Directly emulate an already-orphaned terminal record (no cancel intent).
    const rec = allRecords(instanceId).find((r) => r.run_id === runId)!;
    // Reuse releaseDispatch's 'done'/'failed' finalStates; 'orphaned' isn't
    // one of them, so write it via the same touchHeartbeat-adjacent pattern
    // other run-authority tests use (direct ledger-file edit).
    const recordFile = path.join(tempHome, '.cortextos', instanceId, 'state', 'runs', `${runId}.json`);
    fs.writeFileSync(recordFile, JSON.stringify({ ...rec, state: 'orphaned' }, null, 2));

    const snapshot: AgentsJsonEntry[] = [{ id: 'native-1', state: 'working', sessionId: undefined }];
    const report = reconcile(instanceId, snapshot);

    expect(report.readopted).not.toContain(runId);
    expect(report.stickyLive).toContain(runId);

    const after = allRecords(instanceId).find((r) => r.run_id === runId);
    expect(after?.state).toBe('orphaned');
  });

  it('a sticky record with no matching snapshot entry is left untouched (already correctly terminal)', () => {
    const instanceId = uid('inst');
    const runId = uid('run');

    const reserved = reserve(instanceId, runId);
    expect(reserved.ok).toBe(true);
    releaseDispatch(instanceId, runId, 'done');

    const report = reconcile(instanceId, []);
    expect(report.stickyLive).not.toContain(runId);
    expect(report.readopted).not.toContain(runId);
    expect(report.orphaned).not.toContain(runId);

    const rec = allRecords(instanceId).find((r) => r.run_id === runId);
    expect(rec?.state).toBe('done');
  });

  it('a normal live run with a matching live snapshot entry is still readopted (non-sticky regression)', () => {
    const instanceId = uid('inst');
    const runId = uid('run');

    const reserved = reserve(instanceId, runId);
    expect(reserved.ok).toBe(true);
    touchHeartbeat(instanceId, runId, 'native-1');

    const snapshot: AgentsJsonEntry[] = [{ id: 'native-1', state: 'working', sessionId: undefined }];
    const report = reconcile(instanceId, snapshot);

    expect(report.readopted).toContain(runId);
    expect(report.stickyLive).not.toContain(runId);
  });

  it('M1: a mid-cancel record with no live match in the snapshot is finalized to done and its budget released', () => {
    const instanceId = uid('inst');
    const runId = uid('run');

    const reserved = reserve(instanceId, runId);
    expect(reserved.ok).toBe(true);
    touchHeartbeat(instanceId, runId, 'native-1');
    // Cancel intent recorded, but nobody ever finalized it (e.g. crash
    // between requestCancel and cancelRun's own finalize/terminate step).
    requestCancel(instanceId, runId, 'human');

    const preReconcile = allRecords(instanceId).find((r) => r.run_id === runId);
    expect(preReconcile?.state).toBe('dispatching');
    expect(preReconcile?.budget_reserved).toBeGreaterThan(0);

    // Native side is absent from the snapshot entirely (session already
    // stopped/crashed before it registered) — nothing left to terminate.
    const report = reconcile(instanceId, []);

    expect(report.stickyLive).not.toContain(runId);
    expect(report.completed).toContain(runId);

    const rec = allRecords(instanceId).find((r) => r.run_id === runId);
    expect(rec?.state).toBe('done');
    expect(rec?.cancel_reason).toBe('human');
    expect(rec?.budget_reserved).toBe(0);
  });

  it('H3: an unreliable snapshot (snapshotReliable=false) leaves a live run untouched instead of orphaning it', () => {
    const instanceId = uid('inst');
    const runId = uid('run');

    const reserved = reserve(instanceId, runId);
    expect(reserved.ok).toBe(true);
    touchHeartbeat(instanceId, runId, 'native-1');

    // Promote to 'live' via a reliable reconcile pass first (mirrors normal
    // dispatch → live flow).
    const liveSnapshot: AgentsJsonEntry[] = [{ id: 'native-1', state: 'working', sessionId: undefined }];
    reconcile(instanceId, liveSnapshot);
    expect(allRecords(instanceId).find((r) => r.run_id === runId)?.state).toBe('live');

    // Simulate a cold-boot discovery timeout: empty snapshot, marked unreliable.
    const report = reconcile(instanceId, [], false);

    expect(report.orphaned).not.toContain(runId);
    expect(report.stickyLive).not.toContain(runId);

    const rec = allRecords(instanceId).find((r) => r.run_id === runId);
    expect(rec?.state).toBe('live');
  });
});

// ---------------------------------------------------------------------------
// reissueTermination — escalation
// ---------------------------------------------------------------------------

describe('reissueTermination', () => {
  it('finalizes a mid-cancel record to done (preserving cancel_reason) once the status poll confirms it is dead', async () => {
    const instanceId = uid('inst');
    const runId = uid('run');

    const reserved = reserve(instanceId, runId);
    expect(reserved.ok).toBe(true);
    touchHeartbeat(instanceId, runId, 'native-1');
    requestCancel(instanceId, runId, 'stall');

    const terminateRun = vi.fn().mockResolvedValue(undefined);
    const getStatus = vi.fn().mockResolvedValue({ state: 'done' });

    const result = await reissueTermination(instanceId, runId, {
      terminateRun,
      getStatus,
      gracePollMs: 0,
    });

    expect(result.confirmedDead).toBe(true);
    expect(result.escalatedToOrphan).toBe(false);
    expect(terminateRun).toHaveBeenCalledWith(runId);

    const rec = allRecords(instanceId).find((r) => r.run_id === runId);
    expect(rec?.state).toBe('done');
    expect(rec?.cancel_reason).toBe('stall');
  });

  it('leaves an already-terminal, no-cancel-intent record untouched once confirmed dead (resurrected orphan case)', async () => {
    const instanceId = uid('inst');
    const runId = uid('run');

    const reserved = reserve(instanceId, runId);
    expect(reserved.ok).toBe(true);
    touchHeartbeat(instanceId, runId, 'native-1');
    releaseDispatch(instanceId, runId, 'failed');

    const terminateRun = vi.fn().mockResolvedValue(undefined);
    const getStatus = vi.fn().mockResolvedValue(null);

    const result = await reissueTermination(instanceId, runId, { terminateRun, getStatus, gracePollMs: 0 });

    expect(result.confirmedDead).toBe(true);
    expect(terminateRun).toHaveBeenCalledWith(runId);

    const rec = allRecords(instanceId).find((r) => r.run_id === runId);
    expect(rec?.state).toBe('failed'); // untouched — no cancel_reason to finalize
  });

  it('escalates to orphaned (with loud surfacing) when the native session still reports live after retries exhaust', async () => {
    const instanceId = uid('inst');
    const runId = uid('run');

    const reserved = reserve(instanceId, runId);
    expect(reserved.ok).toBe(true);
    touchHeartbeat(instanceId, runId, 'native-1');
    requestCancel(instanceId, runId, 'human');

    const terminateRun = vi.fn().mockResolvedValue(undefined);
    // Stays "live" no matter how many times we poll — the adapter has no
    // real hard-kill (claude-bg's Known Limitation).
    const getStatus = vi.fn().mockResolvedValue({ state: 'working' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await reissueTermination(instanceId, runId, {
      terminateRun,
      getStatus,
      gracePollMs: 0,
      maxRetries: 1,
    });

    expect(result.confirmedDead).toBe(false);
    expect(result.escalatedToOrphan).toBe(true);
    expect(terminateRun).toHaveBeenCalledTimes(2); // initial attempt + 1 retry
    expect(errSpy).toHaveBeenCalled();

    const rec = allRecords(instanceId).find((r) => r.run_id === runId);
    expect(rec?.state).toBe('orphaned');
    expect(rec?.cancel_reason).toBe('human');

    errSpy.mockRestore();
  });

  it('with no getStatus supplied, trusts a successful terminateRun call as sufficient', async () => {
    const instanceId = uid('inst');
    const runId = uid('run');

    const reserved = reserve(instanceId, runId);
    expect(reserved.ok).toBe(true);
    touchHeartbeat(instanceId, runId, 'native-1');
    requestCancel(instanceId, runId, 'deadline');

    const terminateRun = vi.fn().mockResolvedValue(undefined);

    const result = await reissueTermination(instanceId, runId, { terminateRun });

    expect(result.confirmedDead).toBe(true);
    expect(terminateRun).toHaveBeenCalledTimes(1);

    const rec = allRecords(instanceId).find((r) => r.run_id === runId);
    expect(rec?.state).toBe('done');
    expect(rec?.cancel_reason).toBe('deadline');
  });
});
