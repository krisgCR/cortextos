/**
 * src/runtime/adapters/claude-discovery.ts
 *
 * Conforming stub RuntimeDriver for Claude discovery / reconciliation.
 *
 * Standalone enumerator that uses `claude agents --json --all` to discover
 * all Claude sessions (running and completed) and reconcile them with the
 * cortextOS run-authority ledger.
 *
 * Full tree-reconstruction deferred to N3+.
 *
 * Discovery flow (when implemented):
 *   1. Shell out: `claude agents list --json --all`
 *   2. Parse JSONL output per agent record
 *   3. For each record: compare against run-authority ledger
 *   4. Emit adoptOrphan events for sessions with no known holder
 *   5. Update heartbeats for sessions with a live lease
 *
 * All capabilities are 'unknown' until N3 probing. This adapter is read-only
 * (control.* all 'none') — it observes and reconciles, does not dispatch.
 *
 * Full implementation (dispatch, getStatus, listRuns, parse methods) is deferred
 * to N3+. All methods throw NotImplemented until then.
 */

import { makeCapabilities } from '../capabilities.js';
import type {
  RuntimeDriver,
  RuntimeEvent,
  RunSpec,
  RunStatus,
} from '../../types/index.js';

// Read-only discovery adapter — no control surface.
const CLAUDE_DISCOVERY_CAPABILITIES = makeCapabilities({
  control: {
    submitTurn: 'none',
    steerActiveTurn: 'none',
    interruptTurn: 'none',
    terminateRun: 'none',
    drain: 'none',
  },
});

function notImplemented(method: string): never {
  throw new Error(`NotImplemented: claude-discovery.${method} (N3+)`);
}

export const claudeDiscoveryAdapter: RuntimeDriver = {
  runtime: 'claude-discovery',
  capabilities: CLAUDE_DISCOVERY_CAPABILITIES,

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
