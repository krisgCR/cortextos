/**
 * src/runtime/adapters/claude-bg.ts
 *
 * RuntimeDriver for Claude via `claude --bg` (background sessions).
 *
 * Observation/parse paths are fully implemented with N1.5 measured capability values.
 * Dispatch is gated-closed: no unattended `--bg` dispatch until N4 cost enforcement.
 *
 * Architecture notes:
 *   - No ANSI scraping, no `claude logs` reference anywhere in this file.
 *   - `session_id` from hook events IS the run correlation key for claude-bg.
 *   - `parseAgentsJson` maps `claude agents --json` output to RunStatus.
 *   - `parseHookEvent` maps Claude Code hook payloads to RuntimeEvent.
 *   - Conformance check (N-R2 mitigation): strict validation of required fields
 *     before any access; typed errors carry the raw input for diagnostics.
 *
 * Budget origin: 'native' (Claude tracks and enforces subscription budget).
 * Auth/billing mode: 'oauth→subscription' (always subscription-billed).
 *
 * Capability values are verbatim N1.5 measurements. See:
 *   .planning/cortextos-native-integration-strategy.md §D24, §N1.5
 */

import { makeCapabilities } from '../capabilities.js';
import type {
  BillingPool,
  RuntimeCapabilities,
  RuntimeDriver,
  RuntimeEvent,
  RuntimeEventKind,
  RunSpec,
  RunStatus,
} from '../../types/index.js';

// ---------------------------------------------------------------------------
// Typed parse errors (N-R2 conformance mitigation)
// ---------------------------------------------------------------------------

/**
 * Thrown when `parseAgentsJson` receives a payload that does not conform to
 * the expected `claude agents --json` output shape.
 *
 * `raw` carries the original value for upstream diagnostics / logging.
 */
export class AgentsJsonParseError extends Error {
  readonly raw: unknown;

  constructor(message: string, raw: unknown) {
    super(message);
    this.name = 'AgentsJsonParseError';
    this.raw = raw;
  }
}

/**
 * Thrown when `parseHookEvent` receives a payload that does not conform to
 * the expected Claude Code hook event shape.
 *
 * `raw` carries the original value for upstream diagnostics / logging.
 */
export class HookEventParseError extends Error {
  readonly raw: unknown;

  constructor(message: string, raw: unknown) {
    super(message);
    this.name = 'HookEventParseError';
    this.raw = raw;
  }
}

// ---------------------------------------------------------------------------
// Capability constants — verbatim N1.5 measured values
// ---------------------------------------------------------------------------

const CLAUDE_BG_CAPABILITIES: RuntimeCapabilities = makeCapabilities({
  observe: {
    process: 'native',       // via claude agents --json
    turn: 'native',          // hooks UserPromptSubmit/Stop
    tool: 'native',          // hooks PreToolUse/PostToolUse
    descendants: 'native',   // subagent tree visible in workflow journal
    cost: 'degraded',        // native but ~60s OTel flush delay; per-turn cost from Stop hook
  },
  control: {
    submitTurn: 'none',          // SDK-only
    steerActiveTurn: 'none',     // SDK-only; cooperative = Channel/PreToolUse boundary
    interruptTurn: 'none',       // SDK-only
    terminateRun: 'native',      // claude stop <id>, <1s, conversation retained
    drain: 'none',
  },
  recovery: {
    resumeConversation: 'native',      // respawn
    reattachLiveProcess: 'native',     // native supervisor owns PIDs
    rewindFiles: 'none',
    adoptOrphan: 'native',             // agents --json --all by stable id
  },
  isolation: {
    root: 'worktree',
    descendants: 'runtime-defined',
  },
});

// ---------------------------------------------------------------------------
// State mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map `claude agents --json` state string to RunStatus.state.
 * Anything not explicitly mapped falls through to 'working' (safe default).
 */
function mapAgentsState(
  state: string,
): RunStatus['state'] {
  switch (state) {
    case 'working':
      return 'working';
    case 'blocked':
    case 'waiting':
      return 'blocked';
    case 'completed':
    case 'done':
    case 'succeeded':
      return 'done';
    case 'failed':
    case 'error':
      return 'failed';
    case 'stopped':
    case 'cancelled':
      return 'stopped';
    default:
      return 'working';
  }
}

/**
 * Map a Claude Code hook name to a RuntimeEventKind.
 */
function mapHookNameToKind(hookName: string | undefined): RuntimeEventKind {
  switch (hookName) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'turn';
    case 'PreToolUse':
      return 'tool-call';
    case 'Stop':
      return 'lifecycle';
    default:
      return 'lifecycle';
  }
}

// ---------------------------------------------------------------------------
// Parse functions (public — needed by tests)
// ---------------------------------------------------------------------------

/**
 * Parse raw output from `claude agents list --json` into a RunStatus.
 *
 * N-R2 conformance check: validates required fields before access.
 * Required: id (string), state (string).
 * Optional: waitingFor, cwd, kind, pid, sessionId.
 *
 * @throws {AgentsJsonParseError} when required fields are missing or wrong type.
 */
export function parseAgentsJson(raw: unknown): RunStatus {
  // Conformance check — validate shape before any field access
  if (raw === null || typeof raw !== 'object') {
    throw new AgentsJsonParseError(
      `parseAgentsJson: expected object, got ${typeof raw}`,
      raw,
    );
  }

  const entry = raw as Record<string, unknown>;

  if (typeof entry['id'] !== 'string') {
    throw new AgentsJsonParseError(
      `parseAgentsJson: required field 'id' missing or not a string`,
      raw,
    );
  }

  if (typeof entry['state'] !== 'string') {
    throw new AgentsJsonParseError(
      `parseAgentsJson: required field 'state' missing or not a string`,
      raw,
    );
  }

  return {
    run_id: entry['id'],
    state: mapAgentsState(entry['state']),
    billing_pool: 'subscription',
    heartbeat: new Date().toISOString(),
  };
}

/**
 * Parse a raw Claude Code hook event payload into a RuntimeEvent.
 *
 * `session_id` from the hook IS the run correlation key for claude-bg.
 *
 * @throws {HookEventParseError} when `session_id` is missing or not a string.
 */
export function parseHookEvent(raw: unknown): RuntimeEvent {
  if (raw === null || typeof raw !== 'object') {
    throw new HookEventParseError(
      `parseHookEvent: expected object, got ${typeof raw}`,
      raw,
    );
  }

  const event = raw as Record<string, unknown>;

  if (typeof event['session_id'] !== 'string') {
    throw new HookEventParseError(
      `parseHookEvent: required field 'session_id' missing or not a string`,
      raw,
    );
  }

  const sessionId = event['session_id'];
  const hookName = typeof event['hook_name'] === 'string' ? event['hook_name'] : undefined;

  return {
    kind: mapHookNameToKind(hookName),
    run_id: sessionId,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    payload: event as Record<string, unknown>,
  };
}

/**
 * Map a Claude entrypoint string to the appropriate BillingPool.
 *
 * 'cli'       → 'subscription' (claude --bg runs under OAuth subscription)
 * 'sdk*'      → 'metered'      (SDK calls are API-key billed)
 * anything else → 'unknown'
 */
export function entrypointToBillingPool(entrypoint: string): BillingPool {
  if (entrypoint === 'cli') {
    return 'subscription';
  }
  if (entrypoint.startsWith('sdk')) {
    return 'metered';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// RuntimeDriver implementation
// ---------------------------------------------------------------------------

/**
 * Dispatch a run via `claude --bg`.
 *
 * GATED-CLOSED: Refuses unless the N4 dispatch budget is present and enforcing.
 * For N2, no N4 budget exists → always throws.
 *
 * Extra-usage is NOT a gate condition (it must stay ON account-wide; see D-N2-2).
 * The sole enforced ceiling is the N4 dispatch budget.
 */
async function dispatch(_spec: RunSpec): Promise<void> {
  // 🔴 Gated-closed: refuses unless N4 dispatch budget is present and enforcing.
  // For N2, no N4 budget exists → always refuse.
  // Extra-usage is NOT a gate condition (it must stay ON account-wide; see D-N2-2).
  // The sole enforced ceiling is the N4 dispatch budget.
  throw new Error(
    'ClaudeBgAdapter.dispatch: gated-closed. N4 dispatch budget required. ' +
    'No unattended --bg dispatch until N4 cost enforcement is live.',
  );
}

/**
 * Get the current status of a run by run_id.
 *
 * Stub: real impl via `agents --json` polling is N3+.
 */
async function getStatus(_run_id: string): Promise<RunStatus | null> {
  return Promise.resolve(null);
}

/**
 * List all runs this adapter is currently managing.
 *
 * Stub: real impl is N3+.
 */
async function listRuns(): Promise<RunStatus[]> {
  return Promise.resolve([]);
}

// ---------------------------------------------------------------------------
// Exported adapter singleton
// ---------------------------------------------------------------------------

export const claudeBgAdapter: RuntimeDriver = {
  runtime: 'claude-bg',
  capabilities: CLAUDE_BG_CAPABILITIES,
  dispatch,
  getStatus,
  listRuns,
  parseAgentsJson,
  parseHookEvent,
};
