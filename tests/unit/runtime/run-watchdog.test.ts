/**
 * Unit tests for the run watchdog (Phase 0a Task 3.1 deadline sweep / Task
 * 3.2 stall sweep — src/runtime/run-watchdog.ts).
 *
 * Both sweeps cancel exclusively through `RuntimeDispatcher.cancelRun()` —
 * the same guarded primitive Task 1.2/2.2/2.3 use — so these tests assert
 * against the ledger + adapter.terminateCalls, matching the pattern in
 * dispatcher-cancel.test.ts.
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
import {
  runDeadlineSweep,
  runStallSweep,
  startRunWatchdogLoop,
  NO_ACTIVITY_SIGNAL_SOURCE,
  type ActivitySource,
} from '../../../src/runtime/run-watchdog.js';

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'run-watchdog-test-'));
  delete process.env['CTX_N4_DISPATCH_ENABLED'];
  delete process.env['CTX_RUN_STALL_ENABLED'];
  delete process.env['CTX_RUN_STALL_MS'];
  delete process.env['CTX_RUN_DEADLINE_ENABLED'];
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  delete process.env['CTX_N4_DISPATCH_ENABLED'];
  delete process.env['CTX_RUN_STALL_ENABLED'];
  delete process.env['CTX_RUN_STALL_MS'];
  delete process.env['CTX_RUN_DEADLINE_ENABLED'];
  vi.restoreAllMocks();
  vi.useRealTimers();
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
): RuntimeDriver & { terminateCalls: string[] } {
  const terminateCalls: string[] = [];

  return {
    runtime: 'claude-bg' as Runtime,
    capabilities: STUB_CAPABILITIES,
    terminateCalls,

    async dispatch(spec: RunSpec): Promise<void> {
      // Mirror real adapters (e.g. claude-bg) writing native_id as a side
      // effect of dispatch(), so cancelRun's native_id-present path runs.
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

const DISPATCH_OPTS = { teamBudgetTokens: 10_000, maxConcurrency: 10 };

// ---------------------------------------------------------------------------
// Task 3.1 — deadline sweep
// ---------------------------------------------------------------------------

describe('runDeadlineSweep', () => {
  it('is disabled by default (env unset, enabled omitted) — no-op even past deadline', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    const spec = makeSpec({ deadline: pastDeadline });
    const result = await dispatcher.dispatch(spec, DISPATCH_OPTS);
    expect(result.accepted).toBe(true);

    const swept = await runDeadlineSweep(dispatcher, instanceId);

    expect(swept).toEqual([]);
    expect(adapter.terminateCalls).toHaveLength(0);
    const rec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(rec?.cancel_reason).toBeUndefined();
    expect(rec?.state).toBe('live');
  });

  it('cancels a run whose deadline_at has passed, reason=deadline, terminate called (enabled=true)', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    const spec = makeSpec({ deadline: pastDeadline });
    const result = await dispatcher.dispatch(spec, DISPATCH_OPTS);
    expect(result.accepted).toBe(true);

    const swept = await runDeadlineSweep(dispatcher, instanceId, undefined, true);

    expect(swept).toEqual([{ run_id: spec.run_id, reason: 'deadline' }]);
    expect(adapter.terminateCalls).toContain(spec.run_id);

    const rec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(rec?.cancel_reason).toBe('deadline');
    expect(rec?.state).toBe('done');
  });

  it('does not touch a run whose deadline is still in the future (enabled=true)', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    const futureDeadline = new Date(Date.now() + 3_600_000).toISOString();
    const spec = makeSpec({ deadline: futureDeadline });
    await dispatcher.dispatch(spec, DISPATCH_OPTS);

    const swept = await runDeadlineSweep(dispatcher, instanceId, undefined, true);

    expect(swept).toEqual([]);
    expect(adapter.terminateCalls).toHaveLength(0);
    const rec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(rec?.cancel_reason).toBeUndefined();
  });

  it('first-reason-wins: a run already cancelling for a different reason keeps its original reason (enabled=true)', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    const spec = makeSpec({ deadline: pastDeadline });
    await dispatcher.dispatch(spec, DISPATCH_OPTS);

    // A human cancel wins the race before the watchdog tick runs.
    await dispatcher.cancelRun(spec.run_id, 'human');
    expect(adapter.terminateCalls).toEqual([spec.run_id]);

    const swept = await runDeadlineSweep(dispatcher, instanceId, undefined, true);

    expect(swept).toEqual([]); // sweep did not cause this cancellation
    expect(adapter.terminateCalls).toEqual([spec.run_id]); // no second terminate call
    const rec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(rec?.cancel_reason).toBe('human');
  });

  it('a run with no deadline_at is left alone (enabled=true)', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    // recordRun-only path (no reserveDispatch) never sets deadline_at.
    const { recordRun } = await import('../../../src/runtime/run-authority.js');
    recordRun(instanceId, { run_id: uid('run'), idempotency_key: uid('idem') });

    const swept = await runDeadlineSweep(
      dispatcher,
      instanceId,
      new Date(Date.now() + 10 * 3_600_000),
      true,
    );
    expect(swept).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Task 3.2 — stall sweep (conservative, disabled by default)
// ---------------------------------------------------------------------------

describe('runStallSweep — disabled by default', () => {
  it('is a no-op when CTX_RUN_STALL_ENABLED is unset, even with a real stale activity source', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    const spec = makeSpec();
    await dispatcher.dispatch(spec, DISPATCH_OPTS);

    const staleSource: ActivitySource = {
      lastActivityAt: () => new Date(Date.now() - 24 * 3_600_000).toISOString(),
    };

    const swept = await runStallSweep(dispatcher, instanceId, { activitySource: staleSource });

    expect(swept).toEqual([]);
    expect(adapter.terminateCalls).toHaveLength(0);
  });

  it('the production default (NO_ACTIVITY_SIGNAL_SOURCE) never stalls anything, even when explicitly enabled', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    const spec = makeSpec();
    await dispatcher.dispatch(spec, DISPATCH_OPTS);

    const swept = await runStallSweep(dispatcher, instanceId, {
      enabled: true,
      activitySource: NO_ACTIVITY_SIGNAL_SOURCE,
      stallMs: 1, // even a 1ms window can't fire — there's no timestamp to compare
    });

    expect(swept).toEqual([]);
    expect(adapter.terminateCalls).toHaveLength(0);
  });
});

describe('runStallSweep — enabled, real activity signal (conservative)', () => {
  it('cancels a run with no activity for longer than the stall window, reason=stall', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    const spec = makeSpec();
    await dispatcher.dispatch(spec, DISPATCH_OPTS);

    const silentSince = new Date(Date.now() - 20 * 60_000).toISOString(); // 20 min ago
    const source: ActivitySource = { lastActivityAt: () => silentSince };

    const swept = await runStallSweep(dispatcher, instanceId, {
      enabled: true,
      activitySource: source,
      stallMs: 10 * 60_000, // 10 min window
    });

    expect(swept).toEqual([{ run_id: spec.run_id, reason: 'stall' }]);
    expect(adapter.terminateCalls).toContain(spec.run_id);
    const rec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(rec?.cancel_reason).toBe('stall');
  });

  it('does NOT cancel a run that is still emitting activity within the window', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    const spec = makeSpec();
    await dispatcher.dispatch(spec, DISPATCH_OPTS);

    const recentActivity = new Date(Date.now() - 30_000).toISOString(); // 30s ago
    const source: ActivitySource = { lastActivityAt: () => recentActivity };

    const swept = await runStallSweep(dispatcher, instanceId, {
      enabled: true,
      activitySource: source,
      stallMs: 10 * 60_000,
    });

    expect(swept).toEqual([]);
    expect(adapter.terminateCalls).toHaveLength(0);
  });

  it('does NOT cancel a run inside a single long tool-call whose activity heartbeat is fresh', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    const spec = makeSpec();
    await dispatcher.dispatch(spec, DISPATCH_OPTS);

    // Simulates a long-running single tool call: the last explicit activity
    // heartbeat is from the tool-call's start, which is recent relative to
    // the stall window even though no NEW event has landed since.
    const toolCallStarted = new Date(Date.now() - 4 * 60_000).toISOString(); // 4 min ago
    const source: ActivitySource = { lastActivityAt: () => toolCallStarted };

    const swept = await runStallSweep(dispatcher, instanceId, {
      enabled: true,
      activitySource: source,
      stallMs: 10 * 60_000, // 10 min window — 4 min is well inside it
    });

    expect(swept).toEqual([]);
    expect(adapter.terminateCalls).toHaveLength(0);
  });

  it('does not fire on poll-write alone: frequent ledger heartbeat bumps do not suppress a genuine stall', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    const spec = makeSpec();
    await dispatcher.dispatch(spec, DISPATCH_OPTS);

    // Simulate the observer/ledger bumping RunRecord.heartbeat repeatedly
    // (poll-write time) while the real activity source still reports the
    // run silent — proves the sweep reads the injected ActivitySource, not
    // rec.heartbeat, as its signal.
    touchHeartbeat(instanceId, spec.run_id);
    touchHeartbeat(instanceId, spec.run_id);
    touchHeartbeat(instanceId, spec.run_id);
    const recAfterPolls = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(recAfterPolls?.heartbeat).toBeDefined();

    const silentSince = new Date(Date.now() - 20 * 60_000).toISOString();
    const source: ActivitySource = { lastActivityAt: () => silentSince };

    const swept = await runStallSweep(dispatcher, instanceId, {
      enabled: true,
      activitySource: source,
      stallMs: 10 * 60_000,
    });

    expect(swept).toEqual([{ run_id: spec.run_id, reason: 'stall' }]);
    const rec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(rec?.cancel_reason).toBe('stall');
  });

  it('does not double-cancel: a run already cancelling for another reason keeps it', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    const spec = makeSpec();
    await dispatcher.dispatch(spec, DISPATCH_OPTS);
    await dispatcher.cancelRun(spec.run_id, 'human');

    const source: ActivitySource = {
      lastActivityAt: () => new Date(Date.now() - 24 * 3_600_000).toISOString(),
    };

    const swept = await runStallSweep(dispatcher, instanceId, {
      enabled: true,
      activitySource: source,
      stallMs: 1,
    });

    expect(swept).toEqual([]);
    const rec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(rec?.cancel_reason).toBe('human');
  });
});

// ---------------------------------------------------------------------------
// Loop wiring
// ---------------------------------------------------------------------------

describe('startRunWatchdogLoop', () => {
  it('runs an immediate tick and returns a stop function that clears the interval', async () => {
    const instanceId = uid('inst');
    const adapter = makeFakeAdapter(instanceId);
    const dispatcher = makeDispatcher(instanceId, adapter);

    // The loop calls runDeadlineSweep with its env-default `enabled` param —
    // opt in via the env var so this test still exercises a real firing tick.
    process.env['CTX_RUN_DEADLINE_ENABLED'] = '1';

    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    const spec = makeSpec({ deadline: pastDeadline });
    await dispatcher.dispatch(spec, DISPATCH_OPTS);

    const stop = startRunWatchdogLoop(dispatcher, instanceId, 3_600_000);
    // Immediate tick fires async (fire-and-forget) — flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rec = allRecords(instanceId).find((r) => r.run_id === spec.run_id);
    expect(rec?.cancel_reason).toBe('deadline');

    expect(() => stop()).not.toThrow();
  });
});
