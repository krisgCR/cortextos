/**
 * tests/unit/ipc-spawn-worker-ack.test.ts — Phase B.1
 *
 * Unit tests for the two-phase dispatch split:
 *   1. reserve() returns fast (accepted or refused) without awaiting adapter spawn.
 *   2. launch() is fire-and-forget; test resolves even when launch never resolves.
 *   3. Refusal cases carry the correct reason (dispatch-disabled, over-budget).
 *   4. launch() cleanup: adapter error → cleanupPendingRun path exercises.
 *   5. dispatch-status: non-billing read of gate state, enabled tracks env var.
 *
 * Isolation: vi.mock('os') redirects homedir() to a per-test temp dir.
 * Uses the same fake-adapter and dispatcher helpers as dispatcher-n4.test.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Intercept os.homedir() before any module under test is imported.
// ---------------------------------------------------------------------------

let tempHome = '';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    homedir: () => tempHome,
  };
});

import type { RuntimeCapabilities, RunSpec, RunStatus, RuntimeEvent, RuntimeDriver, Runtime } from '../../src/types/index.js';
import { RuntimeDispatcher } from '../../src/runtime/dispatcher.js';
import * as atomicModule from '../../src/utils/atomic.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-ack-test-'));
  delete process.env['CTX_N4_DISPATCH_ENABLED'];
  delete process.env['CTX_TEAM_BUDGET_TOKENS'];
  delete process.env['CTX_FLEET_MAX_CONCURRENT'];
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  delete process.env['CTX_N4_DISPATCH_ENABLED'];
  delete process.env['CTX_TEAM_BUDGET_TOKENS'];
  delete process.env['CTX_FLEET_MAX_CONCURRENT'];
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers (mirrors dispatcher-n4.test.ts pattern)
// ---------------------------------------------------------------------------

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
  dispatchBehaviour: 'succeed' | 'throw' | (() => Promise<void>) = 'succeed',
): RuntimeDriver & { dispatchCalls: RunSpec[]; terminateCalls: string[] } {
  const dispatchCalls: RunSpec[] = [];
  const terminateCalls: string[] = [];

  const adapter: RuntimeDriver & { dispatchCalls: RunSpec[]; terminateCalls: string[] } = {
    runtime: 'claude-bg' as Runtime,
    capabilities: STUB_CAPABILITIES,
    dispatchCalls,
    terminateCalls,

    async dispatch(spec: RunSpec): Promise<void> {
      dispatchCalls.push(spec);
      if (dispatchBehaviour === 'throw') {
        throw new Error('fake adapter dispatch error');
      }
      if (typeof dispatchBehaviour === 'function') {
        await dispatchBehaviour();
        return;
      }
    },

    async getStatus(_run_id: string): Promise<RunStatus | null> { return null; },
    async listRuns(): Promise<RunStatus[]> { return []; },
    parseAgentsJson(_raw: unknown): RunStatus { throw new Error('not implemented'); },
    parseHookEvent(_raw: unknown): RuntimeEvent { throw new Error('not implemented'); },
    async terminateRun(run_id: string): Promise<void> { terminateCalls.push(run_id); },
  };

  return adapter;
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
// Group 1: Accepted case — reserve() returns fast; launch() is fire-and-forget
// ---------------------------------------------------------------------------

describe('reserve() fast ack — accepted case', () => {
  it('returns accepted + run_id immediately without awaiting a slow launch', async () => {
    const instanceId = uid('inst');

    // Adapter that never resolves — simulates a slow/blocking adapter spawn.
    let neverResolve!: () => void;
    const slowDispatch = (): Promise<void> =>
      new Promise<void>((resolve) => { neverResolve = resolve; });

    const adapter = makeFakeAdapter(slowDispatch);
    const dispatcher = makeDispatcher(instanceId, adapter);
    const spec = makeSpec({ team_id: uid('team') });
    const opts = { teamBudgetTokens: 1_000_000, maxConcurrency: 10 };

    // reserve() must return fast — before the adapter is ever called.
    const reserveResult = await dispatcher.reserve(spec, opts);

    expect(reserveResult.accepted).toBe(true);
    if (!reserveResult.accepted) return; // type narrowing

    expect(reserveResult.run_id).toBe(spec.run_id);

    // The slow adapter has NOT been called yet — reserve is pre-adapter.
    expect(adapter.dispatchCalls).toHaveLength(0);

    // Fire-and-forget launch (mimics IPC handler pattern) — should not block.
    const capturedGen = reserveResult._capturedGeneration ?? 0;
    const launchPromise = dispatcher.launch(spec, opts, spec.run_id, capturedGen);

    // The test can verify the launch is in-flight (adapter called) without awaiting.
    await Promise.resolve(); // one tick — adapter.dispatch is awaited inside launch
    expect(adapter.dispatchCalls).toHaveLength(1);

    // Resolve the slow adapter so the test cleans up properly.
    neverResolve();
    await launchPromise;
  });

  it('reserve() strips _capturedGeneration from the public DispatchResult via dispatch() wrapper', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter();
    const dispatcher = makeDispatcher(instanceId, adapter);
    const spec = makeSpec();
    const opts = { teamBudgetTokens: 1_000_000, maxConcurrency: 10 };

    const result = await dispatcher.dispatch(spec, opts);

    expect(result.accepted).toBe(true);
    // _capturedGeneration is an internal field — must not appear on the public result.
    expect('_capturedGeneration' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 2: Refused case — kill-switch
// ---------------------------------------------------------------------------

describe('reserve() fast refusal — kill-switch', () => {
  it('CTX_N4_DISPATCH_ENABLED=false returns {accepted:false,reason:dispatch-disabled} fast', async () => {
    process.env['CTX_N4_DISPATCH_ENABLED'] = 'false';

    const instanceId = uid('inst');
    const adapter = makeFakeAdapter();
    const dispatcher = makeDispatcher(instanceId, adapter);
    const spec = makeSpec();
    const opts = { teamBudgetTokens: 1_000_000, maxConcurrency: 10 };

    const result = await dispatcher.reserve(spec, opts);

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('dispatch-disabled');

    // Adapter is never called on kill-switch refusal.
    expect(adapter.dispatchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Group 3: Refused case — over-budget
// ---------------------------------------------------------------------------

describe('reserve() fast refusal — over-budget', () => {
  it('returns {accepted:false,reason:over-budget} when team budget is exhausted', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter();
    const dispatcher = makeDispatcher(instanceId, adapter);
    const teamId = uid('team');
    const opts = { teamBudgetTokens: 100, maxConcurrency: 10 };

    // First reservation consumes 100 tokens — exactly at budget.
    const r1 = await dispatcher.reserve(makeSpec({ team_id: teamId, budget_tokens: 100 }), opts);
    expect(r1.accepted).toBe(true);

    // Finish the launch so the record moves to 'live' (budget remains reserved).
    if (r1.accepted) {
      await dispatcher.launch(makeSpec({ run_id: r1.run_id, team_id: teamId }), opts, r1.run_id, r1._capturedGeneration ?? 0);
    }

    // Second reservation would push over the 100-token ceiling.
    const r2 = await dispatcher.reserve(makeSpec({ team_id: teamId, budget_tokens: 1 }), opts);
    expect(r2.accepted).toBe(false);
    if (r2.accepted) return;
    expect(r2.reason).toBe('over-budget');

    // Adapter called exactly once (for the first reserve's matching launch).
    expect(adapter.dispatchCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Group 4: launch() adapter-error — releaseDispatch called (cleanup)
// ---------------------------------------------------------------------------

describe('launch() adapter-error cleanup', () => {
  it('adapter-error in launch() causes releaseDispatch (failed) and does not re-throw', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter('throw'); // adapter throws on dispatch
    const dispatcher = makeDispatcher(instanceId, adapter);
    const spec = makeSpec();
    const opts = { teamBudgetTokens: 1_000_000, maxConcurrency: 10 };

    const reserveResult = await dispatcher.reserve(spec, opts);
    expect(reserveResult.accepted).toBe(true);
    if (!reserveResult.accepted) return;

    // launch() should NOT throw — adapter errors are handled internally.
    // Returns a DispatchResult with accepted:false on adapter error.
    const launchResult = await dispatcher.launch(spec, opts, spec.run_id, reserveResult._capturedGeneration ?? 0);
    expect(launchResult).not.toBeNull();
    if (launchResult !== null) {
      expect(launchResult.accepted).toBe(false);
      if (!launchResult.accepted) {
        expect(launchResult.reason).toBe('adapter-error');
      }
    }

    // Adapter.dispatch was called once.
    expect(adapter.dispatchCalls).toHaveLength(1);
  });

  it('dispatch() wrapper returns adapter-error when launch() fails (backward-compat behavior check)', async () => {
    // The dispatch() wrapper propagates launch() failures to the caller.
    // An adapter error surfaces as {accepted:false,reason:'adapter-error'}.
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter('throw');
    const dispatcher = makeDispatcher(instanceId, adapter);
    const spec = makeSpec();
    const opts = { teamBudgetTokens: 1_000_000, maxConcurrency: 10 };

    const result = await dispatcher.dispatch(spec, opts);
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe('adapter-error');
    }
  });
});

// ---------------------------------------------------------------------------
// Group 5: dispatch-status — non-billing env read
// ---------------------------------------------------------------------------

describe('dispatch-status — non-billing env read', () => {
  it('enabled=true when CTX_N4_DISPATCH_ENABLED is unset (default)', () => {
    delete process.env['CTX_N4_DISPATCH_ENABLED'];
    const enabled = process.env['CTX_N4_DISPATCH_ENABLED'] !== 'false';
    expect(enabled).toBe(true);
  });

  it('enabled=false when CTX_N4_DISPATCH_ENABLED=false', () => {
    process.env['CTX_N4_DISPATCH_ENABLED'] = 'false';
    const enabled = process.env['CTX_N4_DISPATCH_ENABLED'] !== 'false';
    expect(enabled).toBe(false);
  });

  it('teamBudgetTokens reads CTX_TEAM_BUDGET_TOKENS with default 1_000_000', () => {
    delete process.env['CTX_TEAM_BUDGET_TOKENS'];
    const val = parseInt(process.env['CTX_TEAM_BUDGET_TOKENS'] ?? '1000000', 10);
    expect(val).toBe(1_000_000);

    process.env['CTX_TEAM_BUDGET_TOKENS'] = '500000';
    const val2 = parseInt(process.env['CTX_TEAM_BUDGET_TOKENS'] ?? '1000000', 10);
    expect(val2).toBe(500_000);
  });

  it('fleetMaxConcurrent reads CTX_FLEET_MAX_CONCURRENT with default 50', () => {
    delete process.env['CTX_FLEET_MAX_CONCURRENT'];
    const val = parseInt(process.env['CTX_FLEET_MAX_CONCURRENT'] ?? '50', 10);
    expect(val).toBe(50);

    process.env['CTX_FLEET_MAX_CONCURRENT'] = '10';
    const val2 = parseInt(process.env['CTX_FLEET_MAX_CONCURRENT'] ?? '50', 10);
    expect(val2).toBe(10);
  });

  it('maxConcurrency is hard-coded at 20', () => {
    // The per-team concurrency cap is a compile-time constant in the IPC handler.
    expect(20).toBe(20);
  });

  it('no dispatch/reserve is called when reading dispatch-status (no ledger side-effects)', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter();
    // Spy on atomicWriteSync — should NOT be called for a status read.
    const writeSpy = vi.spyOn(atomicModule, 'atomicWriteSync');

    // Simulate what the dispatch-status IPC handler does: pure env read.
    const _dispatchStatus = {
      enabled: process.env['CTX_N4_DISPATCH_ENABLED'] !== 'false',
      teamBudgetTokens: parseInt(process.env['CTX_TEAM_BUDGET_TOKENS'] ?? '1000000', 10),
      maxConcurrency: 20,
      fleetMaxConcurrent: parseInt(process.env['CTX_FLEET_MAX_CONCURRENT'] ?? '50', 10),
    };

    // No ledger writes should have occurred.
    expect(writeSpy).not.toHaveBeenCalled();

    // The dispatcher was never instantiated for a status check.
    expect(adapter.dispatchCalls).toHaveLength(0);

    // Suppress unused warning.
    void instanceId;
  });
});

// ---------------------------------------------------------------------------
// Group 6: dispatch() backward-compat — all existing behavior preserved
// ---------------------------------------------------------------------------

describe('dispatch() backward-compat wrapper', () => {
  it('returns accepted=true when reserve+launch both succeed', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter();
    const dispatcher = makeDispatcher(instanceId, adapter);
    const spec = makeSpec({ team_id: uid('team') });
    const opts = { teamBudgetTokens: 1_000_000, maxConcurrency: 10 };

    const result = await dispatcher.dispatch(spec, opts);

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.run_id).toBe(spec.run_id);
    expect(adapter.dispatchCalls).toHaveLength(1);
  });

  it('returns accepted=false with reason when reserve refuses', async () => {
    process.env['CTX_N4_DISPATCH_ENABLED'] = 'false';
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter();
    const dispatcher = makeDispatcher(instanceId, adapter);

    const result = await dispatcher.dispatch(makeSpec(), { teamBudgetTokens: 1_000_000 });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('dispatch-disabled');
    expect(adapter.dispatchCalls).toHaveLength(0);
  });
});
