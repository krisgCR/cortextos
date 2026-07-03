/**
 * src/runtime/adapters/fake.ts
 *
 * Zero-bill RuntimeDriver for E2E testing — gated by CTX_E2E_FAKE_RUNTIME=1.
 *
 * Purpose: let a REAL dispatch flow through the entire guarded seam
 *   CLI/UI → IPC → daemon → RuntimeDispatcher.reserve() → launch() → ledger → SSE → UI
 * WITHOUT spawning any billed Claude/Codex session. `dispatch()` is a no-op that
 * resolves immediately; the dispatcher then transitions the run to 'live' and
 * writes the RunRecord — so the watcher/SQLite/SSE/dashboard path is exercised
 * end-to-end, and the budget/concurrency/cancel guards (which run at reserve time,
 * before the adapter) are exercised for real.
 *
 * NEVER engages in normal operation: it is only registered into the dispatcher's
 * lanes when `CTX_E2E_FAKE_RUNTIME === '1'` (see agent-manager.ts). It impersonates
 * the 'claude-bg' runtime so the dashboard renders it identically, with no change
 * to the canonical `Runtime` union.
 */

import { makeCapabilities } from '../capabilities.js';
import type {
  RuntimeDriver,
  RuntimeEvent,
  RunSpec,
  RunStatus,
} from '../../types/index.js';

const FAKE_CAPABILITIES = makeCapabilities({
  observe: {
    process: 'native',
    turn: 'none',
    tool: 'none',
    descendants: 'none',
    cost: 'none',
  },
  control: {
    submitTurn: 'none',
    steerActiveTurn: 'none',
    interruptTurn: 'none',
    // terminateRun is functional so cancelTeam() exercises the real path.
    terminateRun: 'native',
    drain: 'none',
  },
  isolation: {
    root: 'cwd',
    descendants: 'shared',
  },
});

/**
 * Stub driver that spawns nothing. Stateless — the dispatcher and run-authority
 * own all ledger state; this adapter only needs to resolve.
 */
export class FakeAdapter implements RuntimeDriver {
  readonly runtime = 'claude-bg' as const;
  readonly capabilities = FAKE_CAPABILITIES;

  /** No-op: resolve immediately. The dispatcher marks the run 'live' after this. */
  async dispatch(_spec: RunSpec): Promise<void> {
    return;
  }

  /** Benign snapshot — never throws (the observer may poll this). */
  async getStatus(run_id: string): Promise<RunStatus | null> {
    return {
      run_id,
      state: 'working',
      billing_pool: 'subscription',
      heartbeat: new Date().toISOString(),
    };
  }

  async listRuns(): Promise<RunStatus[]> {
    return [];
  }

  /** No-op: resolve immediately so cancelTeam()'s release path runs. */
  async terminateRun(_run_id: string): Promise<void> {
    return;
  }

  parseAgentsJson(_raw: unknown): RunStatus {
    throw new Error('NotImplemented: fake.parseAgentsJson (E2E adapter has no real platform output)');
  }

  parseHookEvent(_raw: unknown): RuntimeEvent {
    throw new Error('NotImplemented: fake.parseHookEvent (E2E adapter has no real platform output)');
  }
}
