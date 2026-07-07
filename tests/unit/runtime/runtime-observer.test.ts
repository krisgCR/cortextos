/**
 * Unit tests for runtime-observer.ts — Task 2.1 (Phase 0a / Enforcement wiring).
 *
 * Focus: the observer must mirror the run-authority ledger's cancel state
 * onto the boundary record it writes for the dashboard. A run mid-cancel
 * (cancel_requested_at set, ledger state not yet finalized terminal) must
 * never surface as 'working', even when the native supervisor snapshot
 * still reports the session running.
 *
 * Isolation: vi.mock('os') redirects homedir() to a per-test temp dir (used
 * by run-authority's ledger paths); CTX_ROOT is set per-test to point the
 * observer's boundary-record output at the same temp tree.
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

vi.mock('../../../src/runtime/adapters/claude-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtime/adapters/claude-discovery.js')>();
  return {
    ...actual,
    spawnAgentsCli: vi.fn(),
  };
});

import { observeOnce } from '../../../src/runtime/runtime-observer.js';
import { spawnAgentsCli } from '../../../src/runtime/adapters/claude-discovery.js';
import {
  reserveDispatch,
  requestCancel,
  releaseDispatch,
  touchHeartbeat,
} from '../../../src/runtime/run-authority.js';

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-observer-test-'));
  vi.mocked(spawnAgentsCli).mockReset();
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  delete process.env['CTX_ROOT'];
  vi.restoreAllMocks();
});

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function setCtxRoot(instanceId: string): void {
  process.env['CTX_ROOT'] = path.join(tempHome, '.cortextos', instanceId);
}

function boundaryRecordPath(instanceId: string, runId: string): string {
  return path.join(tempHome, '.cortextos', instanceId, 'state', 'runtimes', `${runId}.json`);
}

function readBoundaryRecord(instanceId: string, runId: string): { state: string } {
  return JSON.parse(fs.readFileSync(boundaryRecordPath(instanceId, runId), 'utf-8'));
}

describe('observeOnce — writes a boundary record per ledger run', () => {
  it('a dispatched (non-cancelled) run yields state/runtimes/<run_id>.json with state "working"', async () => {
    const instanceId = uid('inst');
    const runId = uid('run');
    setCtxRoot(instanceId);

    reserveDispatch(instanceId, {
      run_id: runId,
      idempotency_key: uid('idem'),
      lane: 'claude-bg',
      budget_tokens: 10,
      teamBudgetTokens: 1000,
      maxConcurrency: 5,
    });
    touchHeartbeat(instanceId, runId, 'native-1');

    vi.mocked(spawnAgentsCli).mockResolvedValue({
      entries: [{ id: 'native-1', state: 'working' }],
      stdout: '',
    });

    await observeOnce();

    expect(fs.existsSync(boundaryRecordPath(instanceId, runId))).toBe(true);
    expect(readBoundaryRecord(instanceId, runId).state).toBe('working');
  });
});

describe('observeOnce — cancel-state mirroring (Task 2.1)', () => {
  it('a run mid-cancel (cancel_requested_at set, non-terminal ledger state) is NOT surfaced as working, even though the native supervisor still reports it live', async () => {
    const instanceId = uid('inst');
    const runId = uid('run');
    setCtxRoot(instanceId);

    reserveDispatch(instanceId, {
      run_id: runId,
      idempotency_key: uid('idem'),
      lane: 'claude-bg',
      budget_tokens: 10,
      teamBudgetTokens: 1000,
      maxConcurrency: 5,
    });
    touchHeartbeat(instanceId, runId, 'native-1');
    requestCancel(instanceId, runId, 'human');

    // Native supervisor still reports the session running — the graceful
    // stop hasn't landed yet. The boundary record must not say 'working'.
    vi.mocked(spawnAgentsCli).mockResolvedValue({
      entries: [{ id: 'native-1', state: 'working' }],
      stdout: '',
    });

    await observeOnce();

    expect(readBoundaryRecord(instanceId, runId).state).not.toBe('working');
    expect(readBoundaryRecord(instanceId, runId).state).toBe('stopped');
  });

  it('a finalized cancel (state=done, cancel_reason set) surfaces as done, not overridden to stopped', async () => {
    const instanceId = uid('inst');
    const runId = uid('run');
    setCtxRoot(instanceId);

    reserveDispatch(instanceId, {
      run_id: runId,
      idempotency_key: uid('idem'),
      lane: 'claude-bg',
      budget_tokens: 10,
      teamBudgetTokens: 1000,
      maxConcurrency: 5,
    });
    touchHeartbeat(instanceId, runId, 'native-1');
    requestCancel(instanceId, runId, 'human');
    releaseDispatch(instanceId, runId, 'done');

    vi.mocked(spawnAgentsCli).mockResolvedValue({ entries: [], stdout: '' });

    await observeOnce();

    expect(readBoundaryRecord(instanceId, runId).state).toBe('done');
  });
});
