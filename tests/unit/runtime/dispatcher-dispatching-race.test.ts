/**
 * Integration-style unit tests for RuntimeDispatcher's dispatching-race fence
 * (Task 2.2) and boot-time reconciliation (Task 2.3).
 *
 * Uses a controllable fake adapter — distinct from the happy-path fake in
 * dispatcher-cancel.test.ts and the production zero-bill E2E FakeAdapter
 * (src/runtime/adapters/fake.ts) — that can:
 *   - delay dispatch() until the test explicitly releases it
 *   - write native_id LATE (after the delay), mirroring claude-bg's
 *     writeNativeId-after-await-resolves behavior
 *   - keep getStatus() reporting "live" even after terminateRun() is called
 *     (exercises reissueTermination's grace-poll/retry escalation)
 *
 * The current happy-path fakes cannot exercise either race — this file is
 * the controllable adapter the Verification Contract requires.
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
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-race-test-'));
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

/**
 * Controllable fake adapter: dispatch() blocks until `releaseDispatch(nativeId)`
 * is called by the test, then writes native_id LATE (after the block resolves) —
 * exactly mirroring claude-bg's writeNativeId-after-await-resolves timing.
 * `dispatchStarted` resolves as soon as dispatch() is first invoked, letting the
 * test interleave a concurrent cancelRun() call while native_id is still absent.
 *
 * `statusOverride` lets a test force getStatus() to keep reporting "working"
 * even after terminateRun() has been called, exercising reissueTermination's
 * grace-poll/retry escalation.
 */
function makeControllableAdapter(instanceId: string): RuntimeDriver & {
  terminateCalls: string[];
  dispatchCalls: RunSpec[];
  dispatchStarted: Promise<void>;
  releaseDispatch: (nativeId: string) => void;
  statusOverride: string | null;
} {
  const terminateCalls: string[] = [];
  const dispatchCalls: RunSpec[] = [];
  let resolveStarted!: () => void;
  const dispatchStarted = new Promise<void>((res) => { resolveStarted = res; });
  let resolveBlock: (() => void) | null = null;
  let pendingNativeId = '';

  const adapter = {
    runtime: 'claude-bg' as Runtime,
    capabilities: STUB_CAPABILITIES,
    terminateCalls,
    dispatchCalls,
    dispatchStarted,
    statusOverride: null as string | null,

    releaseDispatch(nativeId: string) {
      pendingNativeId = nativeId;
      if (resolveBlock) resolveBlock();
    },

    async dispatch(spec: RunSpec): Promise<void> {
      dispatchCalls.push(spec);
      resolveStarted();
      await new Promise<void>((res) => { resolveBlock = res; });
      // Native_id written LATE — after the block resolves, mirroring
      // claude-bg writing it as a side effect once the CLI call returns.
      touchHeartbeat(instanceId, spec.run_id, pendingNativeId);
    },

    async getStatus(_run_id: string): Promise<RunStatus | null> {
      if (adapter.statusOverride) {
        return {
          run_id: _run_id,
          state: adapter.statusOverride as RunStatus['state'],
          billing_pool: 'subscription',
          heartbeat: new Date().toISOString(),
        };
      }
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
    },
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
// Task 2.2 — dispatching-race fence
// ---------------------------------------------------------------------------

describe('RuntimeDispatcher.launch — dispatching-race fence (Task 2.2)', () => {
  it('cancel during dispatch (native_id written late) results in the session being terminated, never marked live, and not leaked', async () => {
    const instanceId = uid('inst');
    const adapter = makeControllableAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    const spec = makeSpec();

    // Start the dispatch — this call will block inside adapter.dispatch()
    // until we release it below.
    const dispatchPromise = dispatcher.dispatch(spec, opts);

    // Wait until adapter.dispatch() has actually started (native_id is NOT
    // yet in the ledger at this point — mirrors the real race window).
    await adapter.dispatchStarted;

    const midFlight = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(midFlight?.native_id).toBeUndefined();

    // A cancel lands WHILE dispatch is still in flight and native_id is absent.
    await dispatcher.cancelRun(spec.run_id, 'human');

    const postCancel = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(postCancel?.cancel_reason).toBe('human');
    // cancelRun's no-native_id branch already finalized this to 'done'
    // WITHOUT ever calling terminateRun (nothing to terminate yet).
    expect(postCancel?.state).toBe('done');
    expect(adapter.terminateCalls).toHaveLength(0);

    // Now let the "real" native session spin up — native_id lands LATE,
    // after the cancel already finalized the record.
    adapter.releaseDispatch('native-late-1');
    const result = await dispatchPromise;

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe('cancelled-during-dispatch');
    }

    // The fence-check in launch() must have terminated the just-created
    // native session — closing the leak.
    expect(adapter.terminateCalls).toContain(spec.run_id);

    const finalRec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(finalRec?.state).not.toBe('live');
    expect(finalRec?.native_id).toBe('native-late-1');
  });

  it('a normal (non-cancelled) dispatch is unaffected by the fence check and reaches live', async () => {
    const instanceId = uid('inst');
    const adapter = makeControllableAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    const spec = makeSpec();
    const dispatchPromise = dispatcher.dispatch(spec, opts);
    await adapter.dispatchStarted;
    adapter.releaseDispatch('native-normal-1');

    const result = await dispatchPromise;
    expect(result.accepted).toBe(true);
    expect(adapter.terminateCalls).toHaveLength(0);

    const rec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(rec?.state).toBe('live');
  });
});

// ---------------------------------------------------------------------------
// Task 2.3 — reconcileBoot ("restart") integration
// ---------------------------------------------------------------------------

describe('RuntimeDispatcher.reconcileBoot — restart (Task 2.3)', () => {
  it('a cancel decided just before a simulated crash stays terminal after reconcileBoot (native session actually re-terminated)', async () => {
    const instanceId = uid('inst');
    const adapter = makeControllableAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    const spec = makeSpec();
    // Dispatch fully (native_id present), simulating a run that WAS live.
    const dispatchPromise = dispatcher.dispatch(spec, opts);
    await adapter.dispatchStarted;
    adapter.releaseDispatch('native-crash-1');
    const dispatchResult = await dispatchPromise;
    expect(dispatchResult.accepted).toBe(true);

    // requestCancel wins the CAS but the crash happens before cancelRun's
    // own terminate+finalize step runs — simulate by calling the primitive
    // directly instead of cancelRun.
    const { requestCancel } = await import('../../../src/runtime/run-authority.js');
    requestCancel(instanceId, spec.run_id, 'human');

    const preRestart = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(preRestart?.state).toBe('live'); // never finalized — crash landed here
    expect(preRestart?.cancel_requested_at).toBeDefined();

    // "Restart": the native supervisor still reports the session running.
    adapter.terminateCalls.length = 0;
    const report = await dispatcher.reconcileBoot([{ id: 'native-crash-1', state: 'working', sessionId: undefined }]);

    expect(report.readopted).not.toContain(spec.run_id);
    expect(report.stickyLive).toContain(spec.run_id);
    expect(adapter.terminateCalls).toContain(spec.run_id);

    const after = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(after?.state).toBe('done'); // finalized, reason preserved
    expect(after?.cancel_reason).toBe('human');
  });

  it('a terminal-orphan record is re-terminated, not resurrected as live', async () => {
    const instanceId = uid('inst');
    const adapter = makeControllableAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    const spec = makeSpec();
    const dispatchPromise = dispatcher.dispatch(spec, opts);
    await adapter.dispatchStarted;
    adapter.releaseDispatch('native-orphan-1');
    await dispatchPromise;

    // Simulate an orphan-marking pass having already run (no cancel intent).
    const { releaseDispatch } = await import('../../../src/runtime/run-authority.js');
    releaseDispatch(instanceId, spec.run_id, 'failed');
    const recordFile = path.join(tempHome, '.cortextos', instanceId, 'state', 'runs', `${spec.run_id}.json`);
    const rec = JSON.parse(fs.readFileSync(recordFile, 'utf-8'));
    fs.writeFileSync(recordFile, JSON.stringify({ ...rec, state: 'orphaned' }, null, 2));

    adapter.terminateCalls.length = 0;
    const report = await dispatcher.reconcileBoot([{ id: 'native-orphan-1', state: 'working', sessionId: undefined }]);

    expect(report.readopted).not.toContain(spec.run_id);
    expect(report.stickyLive).toContain(spec.run_id);
    expect(adapter.terminateCalls).toContain(spec.run_id);

    const after = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(after?.state).toBe('orphaned'); // not resurrected to 'live'
  });

  it('escalates to orphaned when the adapter reports the session stays live despite terminateRun (no local hard-kill)', async () => {
    const instanceId = uid('inst');
    const adapter = makeControllableAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    const spec = makeSpec();
    const dispatchPromise = dispatcher.dispatch(spec, opts);
    await adapter.dispatchStarted;
    adapter.releaseDispatch('native-stuck-1');
    await dispatchPromise;

    const { requestCancel } = await import('../../../src/runtime/run-authority.js');
    requestCancel(instanceId, spec.run_id, 'human');

    // getStatus keeps reporting "working" no matter how many times terminateRun runs.
    adapter.statusOverride = 'working';
    adapter.terminateCalls.length = 0;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const report = await dispatcher.reconcileBoot([{ id: 'native-stuck-1', state: 'working', sessionId: undefined }]);

    expect(report.stickyLive).toContain(spec.run_id);
    expect(adapter.terminateCalls.length).toBeGreaterThan(0);

    const after = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(after?.state).toBe('orphaned');
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });
});
