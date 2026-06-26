/**
 * src/runtime/adapters/workflow-observer.ts
 *
 * RuntimeDriver for the Workflow Observer.
 *
 * Reads native Claude workflow journal files to reconstruct the subagent tree
 * and emit RuntimeEvents without polling the live process.
 *
 * Journal file path pattern:
 *   ~/.claude/projects/<session>/subagents/workflows/<runId>/journal.jsonl
 *   ~/.claude/projects/<session>/subagents/workflows/<runId>/agent-<id>.jsonl
 *
 * This is a read-only observer: all control.* capabilities are 'none'.
 * Observation capabilities reflect what journals actually expose:
 *   - process: 'degraded'  (inferred from journal, not live process)
 *   - turn: 'degraded'     (journal records turns but with file-write lag)
 *   - tool: 'degraded'     (tool calls in journal, no live stream)
 *   - descendants: 'degraded' (journal has subagent refs; fidelity depends on child files)
 *   - cost: 'none'         (no cost/token data in journals)
 *
 * dispatch/getStatus/listRuns/parseHookEvent are deferred to N4. All throw NotImplemented.
 * The parse methods (parseJournalEntry, parseWorkflowJournal, isDegraded) are exported
 * for direct unit-test import.
 */

import { makeCapabilities } from '../capabilities.js';
import type {
  AgentNode,
  RuntimeCapabilities,
  RuntimeDriver,
  RuntimeEvent,
  RunSpec,
  RunStatus,
} from '../../types/index.js';

// ---------------------------------------------------------------------------
// Capability constants
// ---------------------------------------------------------------------------

const WORKFLOW_OBSERVER_CAPABILITIES: RuntimeCapabilities = makeCapabilities({
  observe: {
    process: 'degraded',    // inferred from journal lines, not live process
    turn: 'degraded',       // journal records turns with file-write lag
    tool: 'degraded',       // tool calls captured but no live stream
    descendants: 'degraded', // child refs present; fidelity depends on child file availability
    cost: 'none',           // no cost/token data in workflow journals
  },
  control: {
    submitTurn: 'none',
    steerActiveTurn: 'none',
    interruptTurn: 'none',
    terminateRun: 'none',
    drain: 'none',
  },
});

// ---------------------------------------------------------------------------
// Internal types — raw journal line shapes
// ---------------------------------------------------------------------------

/**
 * Raw shape of a journal line we care about.
 * Unknown fields are ignored; unknown `type` values → null (schema-drift defense).
 */
interface JournalLine {
  type: string;
  agentId?: string;
  parentId?: string;
  state?: string;
  label?: string;
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

type AgentNodeState = AgentNode['state'];

function mapJournalState(raw?: string): AgentNodeState {
  switch (raw) {
    case 'working':
    case 'running':
      return 'working';
    case 'blocked':
    case 'waiting':
      return 'blocked';
    case 'done':
    case 'completed':
    case 'stopped':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Pure parse functions (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL line from a workflow journal.
 *
 * Handles `agent.started`, `agent.stopped`, `agent.failed`.
 * Unknown type values → null (schema-drift defense, never throws).
 */
export function parseJournalEntry(line: string): AgentNode | null {
  if (!line.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const entry = parsed as JournalLine;

  switch (entry.type) {
    case 'agent.started':
      return {
        id: entry.agentId ?? 'unknown',
        label: entry.label ?? entry.agentId ?? 'agent',
        state: 'working',
        children: [],
        degraded: false,
      };

    case 'agent.stopped':
      return {
        id: entry.agentId ?? 'unknown',
        label: entry.label ?? entry.agentId ?? 'agent',
        state: mapJournalState(entry.state ?? 'done'),
        children: [],
        degraded: false,
      };

    case 'agent.failed':
      return {
        id: entry.agentId ?? 'unknown',
        label: entry.label ?? entry.agentId ?? 'agent',
        state: 'failed',
        children: [],
        degraded: false,
      };

    default:
      // Unknown type — skip without throwing (schema-drift defense).
      return null;
  }
}

/**
 * Parse a full JSONL journal into an AgentNode tree.
 *
 * Processes each line via `parseJournalEntry`. Builds the tree by:
 * 1. Collecting all nodes into a flat map by id.
 * 2. Applying later entries for the same agentId to update state (last-write wins).
 * 3. Wiring children via parentId. Nodes without parentId are roots.
 *
 * Unknown lines are skipped. Never throws.
 */
export function parseWorkflowJournal(journalContent: string): AgentNode[] {
  const lines = journalContent.split('\n');

  // Phase 1: parse all valid lines, collect into map (last-write wins per agentId).
  // We also track parentId relationships separately to avoid losing them.
  const nodeMap = new Map<string, AgentNode>();
  const parentMap = new Map<string, string>(); // agentId → parentId

  for (const line of lines) {
    if (!line.trim()) continue;

    // Parse the raw entry first to get parentId.
    let rawEntry: unknown;
    try {
      rawEntry = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof rawEntry !== 'object' || rawEntry === null) continue;
    const entry = rawEntry as JournalLine;

    // Track parent relationship regardless of type.
    if (entry.agentId && entry.parentId) {
      parentMap.set(entry.agentId, entry.parentId);
    }

    const node = parseJournalEntry(line);
    if (node === null) continue;

    const existing = nodeMap.get(node.id);
    if (existing) {
      // Last-write wins: update state + label from later events.
      existing.state = node.state;
      if (node.label !== node.id) {
        existing.label = node.label;
      }
    } else {
      nodeMap.set(node.id, node);
    }
  }

  // Phase 2: wire tree (parent→children).
  const roots: AgentNode[] = [];

  for (const [agentId, node] of nodeMap) {
    const parentId = parentMap.get(agentId);
    if (parentId) {
      const parent = nodeMap.get(parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Parent not found in map — treat as root.
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Derive the degraded flag for a tree.
 *
 * Returns true if any node has `degraded: true` OR any node has `state: 'failed'`.
 * Used to set the top-level boundary record `degraded` field.
 */
export function isDegraded(tree: AgentNode[]): boolean {
  for (const node of tree) {
    if (node.degraded || node.state === 'failed') return true;
    if (isDegraded(node.children)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// NotImplemented helper
// ---------------------------------------------------------------------------

function notImplemented(method: string): never {
  throw new Error(`NotImplemented: workflow-observer.${method} (N4)`);
}

// ---------------------------------------------------------------------------
// RuntimeDriver export
// ---------------------------------------------------------------------------

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

  terminateRun(_run_id: string): Promise<void> {
    notImplemented('terminateRun');
  },
};
