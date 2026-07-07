/**
 * Unit tests for the Phase 0a run-scoped cancel primitive (`requestCancel`)
 * and reserve-time `deadline_at` persistence.
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
  reserveDispatch,
  requestCancel,
  releaseDispatch,
  allRecords,
} from '../../../src/runtime/run-authority.js';

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'run-auth-cancel-test-'));
  delete process.env['CTX_RUN_DEADLINE_MS'];
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  delete process.env['CTX_RUN_DEADLINE_MS'];
});

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function reserve(instanceId: string, overrides: Partial<Parameters<typeof reserveDispatch>[1]> = {}) {
  const run_id = uid('run');
  return reserveDispatch(instanceId, {
    run_id,
    idempotency_key: uid('idem'),
    lane: 'claude-bg',
    budget_tokens: 10,
    teamBudgetTokens: 10_000,
    maxConcurrency: 10,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// deadline_at persisted at reserve time
// ---------------------------------------------------------------------------

describe('reserveDispatch — deadline_at', () => {
  it('persists the explicit RunSpec.deadline verbatim', () => {
    const instanceId = uid('inst');
    const explicitDeadline = '2026-08-01T00:00:00.000Z';

    const result = reserve(instanceId, { deadline: explicitDeadline });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.record.deadline_at).toBe(explicitDeadline);
  });

  it('falls back to now + CTX_RUN_DEADLINE_MS when no explicit deadline is given', () => {
    process.env['CTX_RUN_DEADLINE_MS'] = '60000'; // 1 minute
    const instanceId = uid('inst');

    const before = Date.now();
    const result = reserve(instanceId);
    const after = Date.now();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.record.deadline_at).toBeDefined();
    const deadlineMs = new Date(result.record.deadline_at as string).getTime();
    expect(deadlineMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(deadlineMs).toBeLessThanOrEqual(after + 60_000);
  });

  it('falls back to the 1h default when neither deadline nor env var is set', () => {
    const instanceId = uid('inst');
    const before = Date.now();

    const result = reserve(instanceId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const deadlineMs = new Date(result.record.deadline_at as string).getTime();
    // Default is 3_600_000ms (1h) — allow generous slack for test execution time.
    expect(deadlineMs).toBeGreaterThan(before + 3_500_000);
    expect(deadlineMs).toBeLessThan(before + 3_700_000);
  });

  it('deadline_at round-trips through the ledger', () => {
    const instanceId = uid('inst');
    const explicitDeadline = '2026-09-15T12:00:00.000Z';

    const result = reserve(instanceId, { deadline: explicitDeadline });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const records = allRecords(instanceId);
    const rec = records.find((r) => r.run_id === result.record.run_id);
    expect(rec?.deadline_at).toBe(explicitDeadline);
  });
});

// ---------------------------------------------------------------------------
// requestCancel — guarded transition
// ---------------------------------------------------------------------------

describe('requestCancel', () => {
  it('returns null for a run not found in the ledger', () => {
    const instanceId = uid('inst');
    const result = requestCancel(instanceId, uid('missing-run'), 'human');
    expect(result).toBeNull();
  });

  it('applies from a live/pending/dispatching run and records cancel_requested_at + cancel_reason', () => {
    const instanceId = uid('inst');
    const reserved = reserve(instanceId);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    // reserveDispatch leaves the run in 'dispatching'.
    const result = requestCancel(instanceId, reserved.record.run_id, 'human');
    expect(result?.applied).toBe(true);
    expect(result?.record.cancel_reason).toBe('human');
    expect(typeof result?.record.cancel_requested_at).toBe('string');
    // state is intentionally left unchanged by requestCancel — it is the
    // transient "cancelling" signal, not a state-machine transition.
    expect(result?.record.state).toBe('dispatching');
  });

  it('only applies from pending/dispatching/live — a bare-terminal run (done, no prior cancel) is a no-op', () => {
    const instanceId = uid('inst');
    const reserved = reserve(instanceId);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    releaseDispatch(instanceId, reserved.record.run_id, 'done');

    const result = requestCancel(instanceId, reserved.record.run_id, 'human');
    expect(result?.applied).toBe(false);
    expect(result?.record.state).toBe('done');
    expect(result?.record.cancel_reason).toBeUndefined();
  });

  it('a second cancel request is a no-op that preserves the ORIGINAL reason (first-reason-wins)', () => {
    const instanceId = uid('inst');
    const reserved = reserve(instanceId);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    const first = requestCancel(instanceId, reserved.record.run_id, 'human');
    expect(first?.applied).toBe(true);
    expect(first?.record.cancel_reason).toBe('human');

    const second = requestCancel(instanceId, reserved.record.run_id, 'stall');
    expect(second?.applied).toBe(false);
    // Original reason preserved — NOT overwritten by the second call's 'stall'.
    expect(second?.record.cancel_reason).toBe('human');

    // Ledger itself reflects the original reason.
    const rec = allRecords(instanceId).find((r) => r.run_id === reserved.record.run_id);
    expect(rec?.cancel_reason).toBe('human');
  });

  it('cancelling an already-cancelled-and-finalized (done + cancel_reason) run does not overwrite it', () => {
    const instanceId = uid('inst');
    const reserved = reserve(instanceId);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    requestCancel(instanceId, reserved.record.run_id, 'human');
    releaseDispatch(instanceId, reserved.record.run_id, 'done');

    const rec = allRecords(instanceId).find((r) => r.run_id === reserved.record.run_id);
    expect(rec?.state).toBe('done');
    expect(rec?.cancel_reason).toBe('human');

    const result = requestCancel(instanceId, reserved.record.run_id, 'deadline');
    expect(result?.applied).toBe(false);
    expect(result?.record.cancel_reason).toBe('human');
    expect(result?.record.state).toBe('done');
  });
});
