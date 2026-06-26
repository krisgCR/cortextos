/**
 * src/runtime/adapters/hermes.ts
 *
 * Conforming stub RuntimeDriver for the Hermes runtime.
 *
 * Hermes (NousResearch/hermes-agent) is a Python-based persistent REPL.
 * All capabilities are marked 'unknown' — Hermes has not yet been probed
 * under the D24 runtime-boundary protocol.
 *
 * Full implementation (dispatch, getStatus, listRuns, parse methods) is deferred
 * to N3+. All methods throw NotImplemented until then.
 *
 * See: src/pty/agent-pty.ts for the current Hermes PTY spawn path.
 *      AgentConfig.runtime === 'hermes' selects this path.
 */

import { makeCapabilities } from '../capabilities.js';
import type {
  RuntimeDriver,
  RuntimeEvent,
  RunSpec,
  RunStatus,
} from '../../types/index.js';

// All capabilities default to 'unknown' — Hermes has not been probed yet.
const HERMES_CAPABILITIES = makeCapabilities();

function notImplemented(method: string): never {
  throw new Error(`NotImplemented: hermes.${method} (N3+)`);
}

export const hermesAdapter: RuntimeDriver = {
  runtime: 'hermes',
  capabilities: HERMES_CAPABILITIES,

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

  terminateRun(_run_id: string): Promise<void> {
    notImplemented('terminateRun');
  },
};
