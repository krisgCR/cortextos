/**
 * Unit tests for RuntimeDispatcher.cancelRun (Phase 0a Task 1.2) and the
 * cancelTeam regression guard — cancelTeam must keep refusing subsequent
 * dispatch and calling terminateRun exactly as before now that it delegates
 * to the shared cancelRun primitive.
 *
 * Isolation: vi.mock('os') redirects homedir() to a per-test temp dir.
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

import type {
  RuntimeCapabilities,
  RunSpec,
  RunStatus,
  RuntimeEvent,
  RuntimeDriver,
  Runtime,
} from '../../../src/types/index.js';
import { RuntimeDispatcher } from '../../../src/runtime/dispatcher.js';
import { allRecords, touchHeartbeat } from '../../../src/runtime/run-authority.js';

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-cancel-test-'));
  delete process.env['CTX_N4_DISPATCH_ENABLED'];
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  delete process.env['CTX_N4_DISPATCH_ENABLED'];
  vi.restoreAllMocks();
});

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

const STUB_CAPABILITIES: RuntimeCapabilities = {
  observe: { process: 'none', turn: 'none', tool: 'none', descendants: 'none', cost: 'none' },
  control: { submitTurn: 'none', steerActiveTurn: 'none', interruptTurn: 'none', terminateRun: 'native', drain: 'none' },
  recovery: { resumeConversation: 'none', reattachLiveProcess: 'none', rewindFiles: 'none', adoptOrphan: 'none' },
  isolation: { root: 'none', descendants: 'shared' },
};

function makeFakeAdapter(
  instanceId: string,
  terminateBehaviour: 'succeed' | 'throw' = 'succeed',
): RuntimeDriver & { terminateCalls: string[]; dispatchCalls: RunSpec[] } {
  const terminateCalls: string[] = [];
  const dispatchCalls: RunSpec[] = [];

  return {
    runtime: 'claude-bg' as Runtime,
    capabilities: STUB_CAPABILITIES,
    terminateCalls,
    dispatchCalls,

    async dispatch(spec: RunSpec): Promise<void> {
      dispatchCalls.push(spec);
      // Real adapters (e.g. claude-bg) write native_id directly to the
      // ledger as a side effect of dispatch() — mirror that here so
      // cancelRun's native_id-present path is actually exercised.
      touchHeartbeat(instanceId, spec.run_id, `native-${spec.run_id}`);
    },

    async getStatus(_run_id: string): Promise<RunStatus | null> {
      return null;
    },

    async listRuns(): Promise<RunStatus[]> {
      return [];
    },

    parseAgentsJson(_raw: unknown): RunStatus {
      throw new Error('not implemented in fake');
    },

    parseHookEvent(_raw: unknown): RuntimeEvent {
      throw new Error('not implemented in fake');
    },

    async terminateRun(run_id: string): Promise<void> {
      terminateCalls.push(run_id);
      if (terminateBehaviour === 'throw') {
        throw new Error('fake adapter terminate error');
      }
    },
  };
}

function makeDispatcher(instanceId: string, adapter: RuntimeDriver): RuntimeDispatcher {
  const lanes = new Map<string, RuntimeDriver>([['claude-bg', adapter]]);
  return new RuntimeDispatcher(instanceId, lanes);
}

function makeSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  const run_id = uid('run');
  return {
    run_id,
    runtime: 'claude-bg',
    model: 'claude-opus-4-5',
    cwd: '/tmp/fake-cwd',
    idempotency_key: uid('idem'),
    billing_pool: 'subscription',
    budget_tokens: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// cancelRun idempotency
// ---------------------------------------------------------------------------

describe('RuntimeDispatcher.cancelRun', () => {
  it('on a live run: terminates via the adapter and finalizes done with cancel_reason=human', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    const spec = makeSpec();
    const result = await dispatcher.dispatch(spec, opts);
    expect(result.accepted).toBe(true);

    await dispatcher.cancelRun(spec.run_id, 'human');

    expect(adapter.terminateCalls).toContain(spec.run_id);

    const rec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(rec?.state).toBe('done');
    expect(rec?.cancel_reason).toBe('human');
    expect(typeof rec?.cancel_requested_at).toBe('string');
  });

  it('a second cancelRun call with a different reason is a no-op — original reason and terminate-call-count unaffected', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    const spec = makeSpec();
    await dispatcher.dispatch(spec, opts);

    await dispatcher.cancelRun(spec.run_id, 'human');
    expect(adapter.terminateCalls).toHaveLength(1);

    await dispatcher.cancelRun(spec.run_id, 'stall');
    // No second terminate call — the second cancel was a no-op.
    expect(adapter.terminateCalls).toHaveLength(1);

    const rec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(rec?.cancel_reason).toBe('human');
    expect(rec?.state).toBe('done');
  });

  it('cancelling an already-done run (no prior cancel) does not overwrite it', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    const spec = makeSpec();
    await dispatcher.dispatch(spec, opts);

    // Simulate normal completion — no cancel involved.
    const { releaseDispatch } = await import('../../../src/runtime/run-authority.js');
    releaseDispatch(instanceId, spec.run_id, 'done');

    await dispatcher.cancelRun(spec.run_id, 'human');

    expect(adapter.terminateCalls).toHaveLength(0);
    const rec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(rec?.state).toBe('done');
    expect(rec?.cancel_reason).toBeUndefined();
  });

  it('marks the run orphaned when terminateRun fails, preserving the cancel intent', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId, 'throw');
    const dispatcher = makeDispatcher(instanceId, adapter);
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    const spec = makeSpec();
    await dispatcher.dispatch(spec, opts);

    await dispatcher.cancelRun(spec.run_id, 'human');

    const rec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(rec?.state).toBe('orphaned');
    expect(rec?.cancel_reason).toBe('human');
  });

  it('cancelling an unknown run_id is a safe no-op', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    await expect(dispatcher.cancelRun(uid('missing-run'), 'human')).resolves.toBeUndefined();
    expect(adapter.terminateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cancelTeam regression — unchanged behavior after delegating to cancelRun
// ---------------------------------------------------------------------------

describe('RuntimeDispatcher.cancelTeam (regression)', () => {
  it('cancelTeam then dispatch is refused with cancel-in-effect (unchanged)', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);
    const teamId = uid('team');
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    await dispatcher.cancelTeam(teamId);

    const r = await dispatcher.dispatch(makeSpec({ team_id: teamId }), opts);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason).toBe('cancel-in-effect');
    }
    expect(adapter.dispatchCalls).toHaveLength(0);
  });

  it('cancelTeam terminates each live run via the shared cancelRun primitive', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);
    const teamId = uid('team');
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    const spec1 = makeSpec({ team_id: teamId });
    const spec2 = makeSpec({ team_id: teamId });
    await dispatcher.dispatch(spec1, opts);
    await dispatcher.dispatch(spec2, opts);

    await dispatcher.cancelTeam(teamId);

    expect(adapter.terminateCalls).toContain(spec1.run_id);
    expect(adapter.terminateCalls).toContain(spec2.run_id);

    const rec1 = allRecords(instanceId).find((r) => r.run_id === spec1.run_id);
    const rec2 = allRecords(instanceId).find((r) => r.run_id === spec2.run_id);
    expect(rec1?.cancel_reason).toBe('human');
    expect(rec2?.cancel_reason).toBe('human');
    expect(rec1?.state).toBe('done');
    expect(rec2?.state).toBe('done');
  });
});
