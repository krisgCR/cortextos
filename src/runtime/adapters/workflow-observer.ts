/**
 * src/runtime/adapters/workflow-observer.ts
 *
 * Conforming stub RuntimeDriver for the Workflow Observer.
 *
 * The workflow observer reads native Claude workflow journal files to reconstruct
 * the subagent tree and emit RuntimeEvents without polling the live process.
 *
 * Journal file path pattern:
 *   ~/.claude/projects/<session>/subagents/workflows/<runId>/journal.jsonl
 *   ~/.claude/projects/<session>/subagents/workflows/<runId>/agent-*.jsonl
 *
 * This is a read-only observer: all control.* capabilities are 'none'.
 * Observation capabilities will be determined during N3 implementation.
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

// Read-only observer — no control surface. Observe capabilities TBD in N3.
const WORKFLOW_OBSERVER_CAPABILITIES = makeCapabilities({
  control: {
    submitTurn: 'none',
    steerActiveTurn: 'none',
    interruptTurn: 'none',
    terminateRun: 'none',
    drain: 'none',
  },
});

function notImplemented(method: string): never {
  throw new Error(`NotImplemented: workflow-observer.${method} (N3+)`);
}

export const workflowObserverAdapter: RuntimeDriver = {
  runtime: 'workflow-observer',
  capabilities: WORKFLOW_OBSERVER_CAPABILITIES,

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
