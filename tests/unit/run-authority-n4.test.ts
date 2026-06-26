/**
 * Unit tests for N4 ledger logic in run-authority.ts.
 *
 * Tests the five N4 acceptance-criteria groups:
 *   1. Budget ceiling (AC1)
 *   2. Concurrency cap (AC2)
 *   3. Idempotency (AC6)
 *   4. Cancel generation (AC3)
 *   5. Fail-safe foundation (AC7)
 *
 * Isolation strategy: vi.mock('os') redirects homedir() to a per-test temp
 * directory. Each test uses a unique instanceId for a clean ledger.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Intercept os.homedir() before the module under test is imported.
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
  assertGeneration,
  bumpCancelGeneration,
  releaseDispatch,
  reserveDispatch,
  teamRollup,
} from '../../src/runtime/run-authority.js';
import * as atomicModule from '../../src/utils/atomic.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'run-auth-n4-test-'));
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

function uniqueIdemKey(): string {
  return `idem-${Math.random().toString(36).slice(2, 14)}`;
}

const DEFAULT_LANE = 'claude-bg';

// ---------------------------------------------------------------------------
// Group 1: Budget ceiling (AC1)
// ---------------------------------------------------------------------------

describe('Budget ceiling (AC1)', () => {
  it('successive reserves under team budget all succeed', () => {
    const instanceId = uniqueInstance();
    const teamId = 'team-budget-test';
    const teamBudgetTokens = 1000;
    const maxConcurrency = 10;

    const r1 = reserveDispatch(instanceId, {
      run_id: uniqueRunId(),
      idempotency_key: uniqueIdemKey(),
      team_id: teamId,
      lane: DEFAULT_LANE,
      budget_tokens: 300,
      teamBudgetTokens,
      maxConcurrency,
    });
    expect(r1.ok).toBe(true);

    const r2 = reserveDispatch(instanceId, {
      run_id: uniqueRunId(),
      idempotency_key: uniqueIdemKey(),
      team_id: teamId,
      lane: DEFAULT_LANE,
      budget_tokens: 400,
      teamBudgetTokens,
      maxConcurrency,
    });
    expect(r2.ok).toBe(true);
  });

  it('the run that would push over the team ceiling is refused', () => {
    const instanceId = uniqueInstance();
    const teamId = 'team-budget-ceiling';
    const teamBudgetTokens = 1000;
    const maxConcurrency = 10;

    // Reserve 600 of 1000
    const r1 = reserveDispatch(instanceId, {
      run_id: uniqueRunId(),
      idempotency_key: uniqueIdemKey(),
      team_id: teamId,
      lane: DEFAULT_LANE,
      budget_tokens: 600,
      teamBudgetTokens,
      maxConcurrency,
    });
    expect(r1.ok).toBe(true);

    // Reserve 500 more — would push to 1100 > 1000, must be refused
    const r2 = reserveDispatch(instanceId, {
      run_id: uniqueRunId(),
      idempotency_key: uniqueIdemKey(),
      team_id: teamId,
      lane: DEFAULT_LANE,
      budget_tokens: 500,
      teamBudgetTokens,
      maxConcurrency,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.reason).toMatch(/budget ceiling/i);
    }
  });

  it('refused run leaves budget_reserved unchanged', () => {
    const instanceId = uniqueInstance();
    const teamId = 'team-budget-unchanged';
    const teamBudgetTokens = 500;
    const maxConcurrency = 10;

    // Reserve all available budget
    const r1 = reserveDispatch(instanceId, {
      run_id: uniqueRunId(),
      idempotency_key: uniqueIdemKey(),
      team_id: teamId,
      lane: DEFAULT_LANE,
      budget_tokens: 500,
      teamBudgetTokens,
      maxConcurrency,
    });
    expect(r1.ok).toBe(true);

    const rollupBefore = teamRollup(instanceId, teamId);
    expect(rollupBefore.reserved).toBe(500);

    // Attempt to reserve more — should be refused
    const r2 = reserveDispatch(instanceId, {
      run_id: uniqueRunId(),
      idempotency_key: uniqueIdemKey(),
      team_id: teamId,
      lane: DEFAULT_LANE,
      budget_tokens: 100,
      teamBudgetTokens,
      maxConcurrency,
    });
    expect(r2.ok).toBe(false);

    // budget_reserved must not have changed
    const rollupAfter = teamRollup(instanceId, teamId);
    expect(rollupAfter.reserved).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Group 2: Concurrency cap (AC2)
// ---------------------------------------------------------------------------

describe('Concurrency cap (AC2)', () => {
  it('reserves up to maxConcurrency succeed', () => {
    const instanceId = uniqueInstance();
    const teamId = 'team-concurrency-cap';
    const maxConcurrency = 3;
    const teamBudgetTokens = 10000;

    for (let i = 0; i < maxConcurrency; i++) {
      const r = reserveDispatch(instanceId, {
        run_id: uniqueRunId(),
        idempotency_key: uniqueIdemKey(),
        team_id: teamId,
        lane: DEFAULT_LANE,
        budget_tokens: 100,
        teamBudgetTokens,
        maxConcurrency,
      });
      expect(r.ok).toBe(true);
    }
  });

  it('the next dispatch at-cap is refused', () => {
    const instanceId = uniqueInstance();
    const teamId = 'team-at-cap';
    const maxConcurrency = 2;
    const teamBudgetTokens = 10000;

    for (let i = 0; i < maxConcurrency; i++) {
      const r = reserveDispatch(instanceId, {
        run_id: uniqueRunId(),
        idempotency_key: uniqueIdemKey(),
        team_id: teamId,
        lane: DEFAULT_LANE,
        budget_tokens: 100,
        teamBudgetTokens,
        maxConcurrency,
      });
      expect(r.ok).toBe(true);
    }

    const refused = reserveDispatch(instanceId, {
      run_id: uniqueRunId(),
      idempotency_key: uniqueIdemKey(),
      team_id: teamId,
      lane: DEFAULT_LANE,
      budget_tokens: 100,
      teamBudgetTokens,
      maxConcurrency,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toMatch(/concurrency cap/i);
    }
  });

  it('after releaseDispatch("done") a further reserve succeeds', () => {
    const instanceId = uniqueInstance();
    const teamId = 'team-release-slot';
    const maxConcurrency = 1;
    const teamBudgetTokens = 10000;

    const runId = uniqueRunId();
    const r1 = reserveDispatch(instanceId, {
      run_id: runId,
      idempotency_key: uniqueIdemKey(),
      team_id: teamId,
      lane: DEFAULT_LANE,
      budget_tokens: 100,
      teamBudgetTokens,
      maxConcurrency,
    });
    expect(r1.ok).toBe(true);

    // At cap — next should be refused
    const refused = reserveDispatch(instanceId, {
      run_id: uniqueRunId(),
      idempotency_key: uniqueIdemKey(),
      team_id: teamId,
      lane: DEFAULT_LANE,
      budget_tokens: 100,
      teamBudgetTokens,
      maxConcurrency,
    });
    expect(refused.ok).toBe(false);

    // Release the first run
    releaseDispatch(instanceId, runId, 'done');

    // Now a new reserve should succeed
    const r2 = reserveDispatch(instanceId, {
      run_id: uniqueRunId(),
      idempotency_key: uniqueIdemKey(),
      team_id: teamId,
      lane: DEFAULT_LANE,
      budget_tokens: 100,
      teamBudgetTokens,
      maxConcurrency,
    });
    expect(r2.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 3: Idempotency (AC6)
// ---------------------------------------------------------------------------

describe('Idempotency (AC6)', () => {
  it('repeated idempotency_key returns existing record without double-reserve', () => {
    const instanceId = uniqueInstance();
    const teamId = 'team-idempotency';
    const idempotencyKey = uniqueIdemKey();
    const runId = uniqueRunId();
    const teamBudgetTokens = 1000;
    const maxConcurrency = 10;
    const budgetTokens = 200;

    const r1 = reserveDispatch(instanceId, {
      run_id: runId,
      idempotency_key: idempotencyKey,
      team_id: teamId,
      lane: DEFAULT_LANE,
      budget_tokens: budgetTokens,
      teamBudgetTokens,
      maxConcurrency,
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.record.run_id).toBe(runId);
    }

    const rollupAfterFirst = teamRollup(instanceId, teamId);
    expect(rollupAfterFirst.reserved).toBe(budgetTokens);

    // Re-issue with same idempotency key — must return existing record
    const r2 = reserveDispatch(instanceId, {
      run_id: runId,
      idempotency_key: idempotencyKey,
      team_id: teamId,
      lane: DEFAULT_LANE,
      budget_tokens: budgetTokens,
      teamBudgetTokens,
      maxConcurrency,
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.record.run_id).toBe(runId);
    }

    // Budget reserved must NOT be doubled
    const rollupAfterSecond = teamRollup(instanceId, teamId);
    expect(rollupAfterSecond.reserved).toBe(budgetTokens);
    expect(rollupAfterSecond.liveCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Group 4: Cancel generation (AC3 + Codex caveat #2)
// ---------------------------------------------------------------------------

describe('Cancel generation (AC3)', () => {
  it('bumpCancelGeneration then reserveDispatch is refused (cancel in effect)', () => {
    const instanceId = uniqueInstance();
    const teamId = 'team-cancel-gen';

    // Bump — starts at 0, goes to 1
    const gen = bumpCancelGeneration(instanceId, teamId);
    expect(gen).toBe(1);

    // Any further dispatch for this team must be refused
    const refused = reserveDispatch(instanceId, {
      run_id: uniqueRunId(),
      idempotency_key: uniqueIdemKey(),
      team_id: teamId,
      lane: DEFAULT_LANE,
      budget_tokens: 100,
      teamBudgetTokens: 10000,
      maxConcurrency: 10,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toMatch(/cancel/i);
    }
  });

  it('assertGeneration returns false for the pre-bump generation', () => {
    const instanceId = uniqueInstance();
    const teamId = 'team-assert-gen';

    // Initially generation = 0
    expect(assertGeneration(instanceId, teamId, 0)).toBe(true);

    // Bump to 1
    bumpCancelGeneration(instanceId, teamId);

    // Pre-bump expected value (0) no longer matches
    expect(assertGeneration(instanceId, teamId, 0)).toBe(false);
    // Current value (1) does match
    expect(assertGeneration(instanceId, teamId, 1)).toBe(true);
  });

  it('multiple bumps increment monotonically', () => {
    const instanceId = uniqueInstance();
    const teamId = 'team-monotonic';

    expect(bumpCancelGeneration(instanceId, teamId)).toBe(1);
    expect(bumpCancelGeneration(instanceId, teamId)).toBe(2);
    expect(bumpCancelGeneration(instanceId, teamId)).toBe(3);
    expect(assertGeneration(instanceId, teamId, 3)).toBe(true);
    expect(assertGeneration(instanceId, teamId, 2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 5b: Global fleet cap (ADV1)
// ---------------------------------------------------------------------------

describe('Global fleet cap (ADV1)', () => {
  it('solo-team dispatches are refused once the fleet cap is hit', () => {
    const prevEnv = process.env.CTX_FLEET_MAX_CONCURRENT;
    process.env.CTX_FLEET_MAX_CONCURRENT = '2';
    try {
      const instanceId = uniqueInstance();
      const teamBudgetTokens = 10000;
      const maxConcurrency = 10;

      // Two solo dispatches (no team_id) — each synthesises a unique solo:<run_id> team
      const run1 = uniqueRunId();
      const r1 = reserveDispatch(instanceId, {
        run_id: run1,
        idempotency_key: uniqueIdemKey(),
        // no team_id — solo team
        lane: DEFAULT_LANE,
        budget_tokens: 100,
        teamBudgetTokens,
        maxConcurrency,
      });
      expect(r1.ok).toBe(true);

      const run2 = uniqueRunId();
      const r2 = reserveDispatch(instanceId, {
        run_id: run2,
        idempotency_key: uniqueIdemKey(),
        lane: DEFAULT_LANE,
        budget_tokens: 100,
        teamBudgetTokens,
        maxConcurrency,
      });
      expect(r2.ok).toBe(true);

      // Third solo dispatch — fleet cap (2) already hit, must be refused
      const r3 = reserveDispatch(instanceId, {
        run_id: uniqueRunId(),
        idempotency_key: uniqueIdemKey(),
        lane: DEFAULT_LANE,
        budget_tokens: 100,
        teamBudgetTokens,
        maxConcurrency,
      });
      expect(r3.ok).toBe(false);
      if (!r3.ok) {
        expect(r3.reason).toBe('fleet-cap-exceeded');
      }
    } finally {
      if (prevEnv === undefined) {
        delete process.env.CTX_FLEET_MAX_CONCURRENT;
      } else {
        process.env.CTX_FLEET_MAX_CONCURRENT = prevEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Group 5: Fail-safe foundation (AC7)
// ---------------------------------------------------------------------------

describe('Fail-safe foundation (AC7)', () => {
  it('when ledger write throws, the error surfaces rather than silently succeeding', () => {
    const instanceId = uniqueInstance();
    const teamId = 'team-fail-safe';

    // Spy on atomicWriteSync to force it to throw on the next call.
    // run-authority imports atomicWriteSync from atomic.ts; because ESM live
    // bindings share the same module object, spying here intercepts the call.
    const spy = vi.spyOn(atomicModule, 'atomicWriteSync').mockImplementationOnce(() => {
      throw new Error('injected ledger write failure');
    });

    try {
      expect(() =>
        reserveDispatch(instanceId, {
          run_id: uniqueRunId(),
          idempotency_key: uniqueIdemKey(),
          team_id: teamId,
          lane: DEFAULT_LANE,
          budget_tokens: 100,
          teamBudgetTokens: 10000,
          maxConcurrency: 10,
        }),
      ).toThrow('injected ledger write failure');
    } finally {
      spy.mockRestore();
    }
  });
});
