/**
 * Integration tests for RuntimeDispatcher (N4 / D25).
 *
 * Tests the six acceptance-criteria groups:
 *   1. Budget ceiling (AC1)      — over-budget run refused; session never created
 *   2. Concurrency cap (AC2)     — cap at maxConcurrency; N+1 refused
 *   3. Cancel-team race (AC3)    — cancelTeam before/during dispatch → refused + terminate called
 *   4. Idempotency (AC6)         — same idempotency_key yields one session, not two
 *   5. Kill switch (AC7)         — CTX_N4_DISPATCH_ENABLED=false refuses all; live records untouched
 *   6. Fail-safe guard error (AC7) — forced ledger error → guard-error; adapter NEVER called
 *
 * Isolation: vi.mock('os') redirects homedir() to a per-test temp dir.
 * Fake adapter: in-memory RuntimeDriver with configurable behaviour (succeed / throw).
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
import { allRecords } from '../../src/runtime/run-authority.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-n4-test-'));
  // Default: dispatch enabled
  delete process.env['CTX_N4_DISPATCH_ENABLED'];
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  delete process.env['CTX_N4_DISPATCH_ENABLED'];
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
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

/**
 * Build a fake RuntimeDriver.
 *
 * @param dispatchBehaviour - 'succeed' (default), 'throw' (adapter errors on dispatch),
 *                             or a function returning a promise for custom control.
 */
function makeFakeAdapter(
  dispatchBehaviour: 'succeed' | 'throw' | (() => Promise<void>) = 'succeed',
): RuntimeDriver & {
  dispatchCalls: RunSpec[];
  terminateCalls: string[];
} {
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
      // 'succeed' — no-op
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
    },
  };

  return adapter;
}

function makeDispatcher(
  instanceId: string,
  adapter: RuntimeDriver,
): RuntimeDispatcher {
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
// Group 1: Budget ceiling (AC1)
// ---------------------------------------------------------------------------

describe('Budget ceiling (AC1)', () => {
  it('two runs under team budget are accepted; no session created for over-budget run', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter();
    const dispatcher = makeDispatcher(instanceId, adapter);
    const teamId = uid('team');
    const opts = { teamBudgetTokens: 500, maxConcurrency: 10 };

    // First two fit within 500-token budget (200 + 200 = 400 ≤ 500).
    const r1 = await dispatcher.dispatch(makeSpec({ team_id: teamId, budget_tokens: 200 }), opts);
    expect(r1.accepted).toBe(true);

    const r2 = await dispatcher.dispatch(makeSpec({ team_id: teamId, budget_tokens: 200 }), opts);
    expect(r2.accepted).toBe(true);

    // Third would push to 600 > 500.
    const r3 = await dispatcher.dispatch(makeSpec({ team_id: teamId, budget_tokens: 200 }), opts);
    expect(r3.accepted).toBe(false);
    if (!r3.accepted) {
      expect(r3.reason).toBe('over-budget');
    }

    // Adapter was called exactly twice — not for the refused run.
    expect(adapter.dispatchCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Group 2: Concurrency cap (AC2)
// ---------------------------------------------------------------------------

describe('Concurrency cap (AC2)', () => {
  it('exactly maxConcurrency runs accepted; next is refused at-cap', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter();
    const dispatcher = makeDispatcher(instanceId, adapter);
    const teamId = uid('team');
    const maxConcurrency = 3;
    // Large enough budget to never be the limiting factor.
    const opts = { teamBudgetTokens: 1_000_000, maxConcurrency };

    for (let i = 0; i < maxConcurrency; i++) {
      const r = await dispatcher.dispatch(makeSpec({ team_id: teamId, budget_tokens: 10 }), opts);
      expect(r.accepted).toBe(true);
    }

    const refused = await dispatcher.dispatch(makeSpec({ team_id: teamId, budget_tokens: 10 }), opts);
    expect(refused.accepted).toBe(false);
    if (!refused.accepted) {
      expect(refused.reason).toBe('at-cap');
    }

    // Only maxConcurrency adapter calls made.
    expect(adapter.dispatchCalls).toHaveLength(maxConcurrency);
  });
});

// ---------------------------------------------------------------------------
// Group 2b: Global fleet cap (ADV1) — solo-team bypass blocked + reason surfaced
// ---------------------------------------------------------------------------

describe('Global fleet cap (ADV1)', () => {
  const PRIOR = process.env['CTX_FLEET_MAX_CONCURRENT'];
  afterEach(() => {
    if (PRIOR === undefined) delete process.env['CTX_FLEET_MAX_CONCURRENT'];
    else process.env['CTX_FLEET_MAX_CONCURRENT'] = PRIOR;
  });

  it('solo-team dispatches cannot bypass the global cap, and the reason surfaces as fleet-cap-exceeded (not at-cap)', async () => {
    process.env['CTX_FLEET_MAX_CONCURRENT'] = '2';
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter();
    const dispatcher = makeDispatcher(instanceId, adapter);
    // No team_id → each run is its own solo team; the per-team cap would never bite.
    const opts = { teamBudgetTokens: 1_000_000, maxConcurrency: 20 };

    const r1 = await dispatcher.dispatch(makeSpec({ budget_tokens: 1 }), opts);
    const r2 = await dispatcher.dispatch(makeSpec({ budget_tokens: 1 }), opts);
    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(true);

    const refused = await dispatcher.dispatch(makeSpec({ budget_tokens: 1 }), opts);
    expect(refused.accepted).toBe(false);
    if (!refused.accepted) {
      // Regression guard: 'fleet-cap-exceeded' contains the substring 'cap', so the
      // dispatcher's reason-normalization must match 'fleet' BEFORE the generic 'cap'
      // branch — otherwise the fleet cap is indistinguishable from the per-team cap.
      expect(refused.reason).toBe('fleet-cap-exceeded');
    }

    // The refused (3rd) solo dispatch never reached the adapter.
    expect(adapter.dispatchCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Group 3: Cancel-team race (AC3)
// ---------------------------------------------------------------------------

describe('Cancel-team race (AC3)', () => {
  it('cancelTeam then dispatch is refused with cancel-in-effect', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter();
    const dispatcher = makeDispatcher(instanceId, adapter);
    const teamId = uid('team');
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    await dispatcher.cancelTeam(teamId);

    const r = await dispatcher.dispatch(makeSpec({ team_id: teamId }), opts);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason).toBe('cancel-in-effect');
    }
    // Adapter must never be called after a cancel.
    expect(adapter.dispatchCalls).toHaveLength(0);
  });

  it('dispatch past reserve but finalising after mid-flight cancelTeam is rolled back + terminate called', async () => {
    const instanceId = uid('inst');
    const teamId = uid('team');
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };
    let resolveDispatch!: () => void;

    // Adapter that pauses mid-flight so we can cancel between reserve and mark-live.
    const dispatchBehaviour = (): Promise<void> =>
      new Promise<void>((resolve) => {
        resolveDispatch = resolve;
      });

    const adapter = makeFakeAdapter(dispatchBehaviour);
    const dispatcher = makeDispatcher(instanceId, adapter);

    const spec = makeSpec({ team_id: teamId });

    // Start a dispatch — it will pause inside the adapter's dispatch() call.
    const dispatchPromise = dispatcher.dispatch(spec, opts);

    // Yield to let the dispatcher reach the adapter call (it runs synchronously
    // up to the adapter.dispatch() await, then yields here).
    await Promise.resolve();

    // Cancel the team while the adapter is mid-flight.
    await dispatcher.cancelTeam(teamId);

    // Now let the adapter finish.
    resolveDispatch();
    const result = await dispatchPromise;

    // The dispatcher must detect the stale generation and refuse.
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe('stale-generation');
    }

    // terminateRun must have been called on the mid-flight run.
    expect(adapter.terminateCalls).toContain(spec.run_id);
  });
});

// ---------------------------------------------------------------------------
// Group 4: Idempotency (AC6)
// ---------------------------------------------------------------------------

describe('Idempotency (AC6)', () => {
  it('same idempotency_key yields one session, not two', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter();
    const dispatcher = makeDispatcher(instanceId, adapter);
    const teamId = uid('team');
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };
    const idemKey = uid('idem');
    const runId = uid('run');

    const spec = makeSpec({ run_id: runId, idempotency_key: idemKey, team_id: teamId });

    const r1 = await dispatcher.dispatch(spec, opts);
    expect(r1.accepted).toBe(true);

    // Re-dispatch with identical spec and same idempotency_key.
    const r2 = await dispatcher.dispatch(spec, opts);
    expect(r2.accepted).toBe(true);

    // Budget must not be double-reserved: only one live record in the ledger.
    const records = allRecords(instanceId).filter((r) => r.team_id === teamId);
    expect(records).toHaveLength(1);

    // Adapter dispatch called exactly once — idempotency path exits early at guard.
    expect(adapter.dispatchCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Group 5: Kill switch (AC7)
// ---------------------------------------------------------------------------

describe('Kill switch (AC7)', () => {
  it('CTX_N4_DISPATCH_ENABLED=false refuses all dispatches with dispatch-disabled', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter();
    const dispatcher = makeDispatcher(instanceId, adapter);
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    // Seed a live record to confirm it is untouched after a kill-switch refusal.
    // We dispatch once while enabled to create the record.
    const liveSpec = makeSpec({ team_id: uid('team') });
    const seed = await dispatcher.dispatch(liveSpec, opts);
    expect(seed.accepted).toBe(true);

    // Now flip the kill switch.
    process.env['CTX_N4_DISPATCH_ENABLED'] = 'false';

    const r = await dispatcher.dispatch(makeSpec(), opts);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason).toBe('dispatch-disabled');
    }

    // Adapter was called only for the seed dispatch, not the refused one.
    expect(adapter.dispatchCalls).toHaveLength(1);

    // The prior live record is still live — kill switch does not touch existing runs.
    const records = allRecords(instanceId);
    const liveRec = records.find((r) => r.run_id === liveSpec.run_id);
    expect(liveRec).toBeDefined();
    expect(liveRec?.state).toBe('live');
  });
});

// ---------------------------------------------------------------------------
// Group 6: Fail-safe guard error (AC7)
// ---------------------------------------------------------------------------

describe('Fail-safe guard error (AC7)', () => {
  it('forced ledger-read error causes guard-error refusal; adapter NEVER called', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter();
    const dispatcher = makeDispatcher(instanceId, adapter);
    const opts = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

    // Force atomicWriteSync (used by reserveDispatch's final write) to throw.
    // This simulates a disk-full or permissions error in the guard path.
    vi.spyOn(atomicModule, 'atomicWriteSync').mockImplementationOnce(() => {
      throw new Error('injected disk-full ledger error');
    });

    const r = await dispatcher.dispatch(makeSpec(), opts);

    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason).toBe('guard-error');
    }

    // The adapter must never have been called.
    expect(adapter.dispatchCalls).toHaveLength(0);
  });
});
