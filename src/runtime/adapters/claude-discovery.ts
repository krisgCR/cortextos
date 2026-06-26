/**
 * src/runtime/adapters/claude-discovery.ts
 *
 * RuntimeDriver for Claude discovery / reconciliation.
 *
 * Standalone enumerator that uses `claude agents --json --all` to discover
 * all Claude sessions (running and completed) and reconcile them with the
 * cortextOS run-authority ledger.
 *
 * Discovery flow:
 *   1. Shell out: `claude agents --json --all`
 *   2. Parse JSON array output into AgentsJsonEntry[]
 *   3. Feed result to run-authority.reconcile() (privacy / ledger gate)
 *   4. Emit adoptOrphan events for sessions with no known holder
 *   5. Update heartbeats for sessions with a live lease
 *
 * Observation capabilities:
 *   - process: 'degraded'     (polled, not event-driven)
 *   - turn: 'none'            (--json gives no per-turn data)
 *   - tool: 'none'            (--json gives no tool data)
 *   - descendants: 'degraded' (flat listing, no hierarchy from --json)
 *   - cost: 'none'            (no cost data from --json)
 *
 * This adapter is read-only (control.* all 'none').
 * dispatch/getStatus/listRuns/parseHookEvent keep throwing NotImplemented (N4).
 *
 * Graceful degradation: CLI absent / non-zero exit / non-JSON stdout →
 *   returns { entries: [], stdout: '' } — never throws.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { makeCapabilities } from '../capabilities.js';
import type { AgentsJsonEntry } from '../run-authority.js';
import type {
  RuntimeCapabilities,
  RuntimeDriver,
  RuntimeEvent,
  RunSpec,
  RunStatus,
} from '../../types/index.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Capability constants
// ---------------------------------------------------------------------------

const CLAUDE_DISCOVERY_CAPABILITIES: RuntimeCapabilities = makeCapabilities({
  observe: {
    process: 'degraded',    // polled via CLI, not event-driven
    turn: 'none',           // --json gives no per-turn data
    tool: 'none',           // --json gives no tool call data
    descendants: 'degraded', // flat listing, no hierarchy
    cost: 'none',           // no cost data from --json
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
// State mapping — native CLI states → RunStatus.state
// ---------------------------------------------------------------------------

type RunState = RunStatus['state'];

function mapNativeState(raw: string): RunState {
  switch (raw) {
    case 'working':
    case 'running':
    case 'active':
    case 'started':
      return 'working';
    case 'blocked':
    case 'waiting':
      return 'blocked';
    case 'done':
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      // Unknown native states default to 'stopped' (conservative — don't assume live).
      return 'stopped';
  }
}

// ---------------------------------------------------------------------------
// Pure parse functions (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse the JSON array output of `claude agents --json --all` into AgentsJsonEntry[].
 *
 * Each entry must have at minimum an `id` field. Unknown or malformed entries are
 * skipped (not thrown on). Returns [] for completely unparseable input.
 */
export function parseAgentsJson(stdout: string): AgentsJsonEntry[] {
  if (!stdout.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const results: AgentsJsonEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;

    if (typeof entry['id'] !== 'string') continue; // required field
    if (typeof entry['state'] !== 'string') continue; // required field

    results.push({
      id: entry['id'],
      state: entry['state'],
      sessionId: typeof entry['sessionId'] === 'string' ? entry['sessionId'] : undefined,
      cwd: typeof entry['cwd'] === 'string' ? entry['cwd'] : undefined,
    });
  }

  return results;
}

/**
 * Spawn `claude agents --json --all` and parse the output.
 *
 * Graceful degradation: CLI absent, non-zero exit, or non-JSON output →
 *   returns { entries: [], stdout: '' } — never throws.
 */
export async function spawnAgentsCli(): Promise<{ entries: AgentsJsonEntry[]; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('claude', ['agents', '--json', '--all'], {
      timeout: 10_000,
    });
    const entries = parseAgentsJson(stdout);
    return { entries, stdout };
  } catch {
    // CLI absent, non-zero exit, timeout, or any other error.
    return { entries: [], stdout: '' };
  }
}

// ---------------------------------------------------------------------------
// NotImplemented helper
// ---------------------------------------------------------------------------

function notImplemented(method: string): never {
  throw new Error(`NotImplemented: claude-discovery.${method} (N4)`);
}

// ---------------------------------------------------------------------------
// RuntimeDriver export
// ---------------------------------------------------------------------------

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

  terminateRun(_run_id: string): Promise<void> {
    notImplemented('terminateRun');
  },
};
