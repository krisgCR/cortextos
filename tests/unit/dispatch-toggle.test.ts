/**
 * tests/unit/dispatch-toggle.test.ts
 *
 * Runtime kill-switch toggle (set-dispatch-enabled IPC). The handler mutates
 * process.env['CTX_N4_DISPATCH_ENABLED'] in the daemon process; dispatcher.reserve()
 * reads it live on every call, so the toggle takes effect for the next dispatch
 * with no restart. These tests assert that behavioral contract end-to-end:
 *
 *   1. Pausing (enabled=false) makes a subsequent reserve() refuse 'dispatch-disabled'.
 *   2. Resuming (enabled=true) makes a subsequent reserve() accept again.
 *   3. The handler's validation rejects a non-boolean `enabled`.
 *
 * Isolation: vi.mock('os') redirects homedir() to a per-test temp dir so no real
 * ledger is touched.
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

import type { RuntimeCapabilities, RunSpec, RunStatus, RuntimeEvent, RuntimeDriver, Runtime } from '../../src/types/index.js';
import { RuntimeDispatcher } from '../../src/runtime/dispatcher.js';

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-toggle-test-'));
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

function makeFakeAdapter(): RuntimeDriver {
  return {
    runtime: 'claude-bg' as Runtime,
    capabilities: STUB_CAPABILITIES,
    async dispatch(_spec: RunSpec): Promise<void> { /* no-op */ },
    async getStatus(_run_id: string): Promise<RunStatus | null> { return null; },
    async listRuns(): Promise<RunStatus[]> { return []; },
    parseAgentsJson(_raw: unknown): RunStatus { throw new Error('not implemented'); },
    parseHookEvent(_raw: unknown): RuntimeEvent { throw new Error('not implemented'); },
    async terminateRun(_run_id: string): Promise<void> { /* no-op */ },
  };
}

function makeDispatcher(instanceId: string): RuntimeDispatcher {
  const lanes = new Map<string, RuntimeDriver>([['claude-bg', makeFakeAdapter()]]);
  return new RuntimeDispatcher(instanceId, lanes);
}

function makeSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    run_id: uid('run'),
    runtime: 'claude-bg',
    model: 'claude-opus-4-5',
    cwd: '/tmp/fake-cwd',
    idempotency_key: uid('idem'),
    billing_pool: 'subscription',
    budget_tokens: 100,
    ...overrides,
  };
}

/** Mirrors the set-dispatch-enabled IPC handler in src/daemon/ipc-server.ts. */
function applyToggle(enabled: unknown): { success: boolean; error?: string } {
  if (typeof enabled !== 'boolean') {
    return { success: false, error: 'set-dispatch-enabled requires data.enabled (boolean)' };
  }
  process.env['CTX_N4_DISPATCH_ENABLED'] = enabled ? 'true' : 'false';
  return { success: true };
}

describe('runtime kill-switch toggle (set-dispatch-enabled)', () => {
  it('pausing makes the next reserve() refuse dispatch-disabled', async () => {
    const dispatcher = makeDispatcher(uid('inst'));
    const opts = { teamBudgetTokens: 1_000_000, maxConcurrency: 10 };

    // Baseline: enabled by default → accepts.
    const before = await dispatcher.reserve(makeSpec({ team_id: uid('team') }), opts);
    expect(before.accepted).toBe(true);

    // Pause via the handler logic.
    expect(applyToggle(false).success).toBe(true);
    expect(process.env['CTX_N4_DISPATCH_ENABLED']).toBe('false');

    // Next reserve() must refuse with dispatch-disabled — no restart needed.
    const after = await dispatcher.reserve(makeSpec({ team_id: uid('team') }), opts);
    expect(after.accepted).toBe(false);
    if (after.accepted) return; // type narrowing
    expect(after.reason).toBe('dispatch-disabled');
  });

  it('resuming after a pause makes the next reserve() accept again', async () => {
    const dispatcher = makeDispatcher(uid('inst'));
    const opts = { teamBudgetTokens: 1_000_000, maxConcurrency: 10 };

    applyToggle(false);
    const paused = await dispatcher.reserve(makeSpec({ team_id: uid('team') }), opts);
    expect(paused.accepted).toBe(false);

    applyToggle(true);
    expect(process.env['CTX_N4_DISPATCH_ENABLED']).toBe('true');

    const resumed = await dispatcher.reserve(makeSpec({ team_id: uid('team') }), opts);
    expect(resumed.accepted).toBe(true);
  });

  it('rejects a non-boolean enabled and does not mutate the env', () => {
    delete process.env['CTX_N4_DISPATCH_ENABLED'];
    const result = applyToggle('false'); // string, not boolean
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/boolean/);
    expect(process.env['CTX_N4_DISPATCH_ENABLED']).toBeUndefined();
  });
});
