/**
 * src/runtime/adapters/codex-app-server.ts
 *
 * Conforming stub RuntimeDriver for the Codex App Server runtime.
 *
 * The codex-app-server is a persistent, steerable runtime:
 *   - `control.steerActiveTurn` and `control.submitTurn` are 'native' (unique
 *     to this runtime — the app server exposes a channel for mid-turn injection).
 *   - Billing context: metered (API-key billed, not subscription).
 *   - Isolation root: 'cwd' (each run gets a unique working directory).
 *
 * Full implementation (dispatch, getStatus, listRuns, parse methods) is deferred
 * to N3+. All methods throw NotImplemented until then.
 *
 * See: src/pty/codex-app-server-pty.ts for the PTY-level integration.
 */

import { makeCapabilities } from '../capabilities.js';
import type {
  RuntimeDriver,
  RuntimeEvent,
  RunSpec,
  RunStatus,
} from '../../types/index.js';

const CODEX_APP_SERVER_CAPABILITIES = makeCapabilities({
  control: {
    submitTurn: 'native',
    steerActiveTurn: 'native',
    interruptTurn: 'none',
    terminateRun: 'none',
    drain: 'none',
  },
  isolation: {
    root: 'cwd',
    descendants: 'shared',
  },
});

function notImplemented(method: string): never {
  throw new Error(`NotImplemented: codex-app-server.${method} (N3+)`);
}

export const codexAppServerAdapter: RuntimeDriver = {
  runtime: 'codex-app-server',
  capabilities: CODEX_APP_SERVER_CAPABILITIES,

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
