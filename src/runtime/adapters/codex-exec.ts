/**
 * src/runtime/adapters/codex-exec.ts
 *
 * Conforming stub RuntimeDriver for the Codex Exec (one-shot) runtime.
 *
 * codex-exec is a one-shot, non-interactive invocation:
 *   - Observe: process and turn are 'native'; tool and descendants are 'none'
 *     (one-shot, no mid-turn tool streaming).
 *   - Cost: 'native' (codex exec reports cost on completion).
 *   - All control.* capabilities are 'none' (no mid-run steering possible).
 *   - Billing context: metered (API-key billed).
 *
 * Full implementation (dispatch, getStatus, listRuns, parse methods) is deferred
 * to N3+. All methods throw NotImplemented until then.
 *
 * See: src/pty/codex-worker-pty.ts for the PTY-level integration.
 */

import { makeCapabilities } from '../capabilities.js';
import type {
  RuntimeDriver,
  RuntimeEvent,
  RunSpec,
  RunStatus,
} from '../../types/index.js';

const CODEX_EXEC_CAPABILITIES = makeCapabilities({
  observe: {
    process: 'native',
    turn: 'native',
    tool: 'none',
    descendants: 'none',
    cost: 'native',
  },
  // control.* all stay 'none' (makeCapabilities defaults to 'unknown';
  // one-shot exec has no control surface at all — explicitly 'none' here)
  control: {
    submitTurn: 'none',
    steerActiveTurn: 'none',
    interruptTurn: 'none',
    terminateRun: 'none',
    drain: 'none',
  },
});

function notImplemented(method: string): never {
  throw new Error(`NotImplemented: codex-exec.${method} (N3+)`);
}

export const codexExecAdapter: RuntimeDriver = {
  runtime: 'codex-exec',
  capabilities: CODEX_EXEC_CAPABILITIES,

  dispatch(_spec: RunSpec): Promise<void> {
    notImplemented('dispatch');
  },

  getStatus(_run_id: string): Promise<RunStatus | null> {
    notImplemented('getStatus');
  },

  listRuns(): Promise<RunStatus[]> {
    notImplemented('listRuns');
  },

  parseAgentsJson(_raw: unknown): RunStatus {
    notImplemented('parseAgentsJson');
  },

  parseHookEvent(_raw: unknown): RuntimeEvent {
    notImplemented('parseHookEvent');
  },
};
