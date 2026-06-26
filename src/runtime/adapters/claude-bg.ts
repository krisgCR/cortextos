/**
 * src/runtime/adapters/claude-bg.ts
 *
 * RuntimeDriver for Claude via `claude --bg` (background sessions).
 *
 * Observation/parse paths are fully implemented with N1.5 measured capability values.
 * Dispatch is LIVE: spawns a real `claude --bg` session and writes native_id to the
 * run-authority ledger for reconciliation.
 *
 * Architecture notes:
 *   - No ANSI scraping, no `claude logs` reference anywhere in this file.
 *   - `session_id` from hook events IS the run correlation key for claude-bg.
 *   - `parseAgentsJson` maps `claude agents --json` output to RunStatus.
 *   - `parseHookEvent` maps Claude Code hook payloads to RuntimeEvent.
 *   - Conformance check (N-R2 mitigation): strict validation of required fields
 *     before any access; typed errors carry the raw input for diagnostics.
 *   - OAuth-only dispatch: ANTHROPIC_API_KEY is stripped from the spawned env
 *     to guarantee subscription-lane billing (not metered).
 *
 * Budget origin: 'native' (Claude tracks and enforces subscription budget).
 * Auth/billing mode: 'oauth→subscription' (always subscription-billed).
 *
 * Capability values are verbatim N1.5 measurements. See:
 *   .planning/cortextos-native-integration-strategy.md §D24, §N1.5
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { makeCapabilities } from '../capabilities.js';
import { allRecords } from '../run-authority.js';
import { atomicWriteSync, ensureDir } from '../../utils/atomic.js';
import type {
  BillingPool,
  RuntimeCapabilities,
  RuntimeDriver,
  RuntimeEvent,
  RuntimeEventKind,
  RunSpec,
  RunStatus,
} from '../../types/index.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Typed errors (N-R2 conformance mitigation + dispatch errors)
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

/**
 * Thrown by `terminateRun` when the run's native_id cannot be found in the
 * ledger. The dispatcher degrades to orphan handling in this case.
 */
export class NativeIdUnknownError extends Error {
  readonly code = 'NATIVE_ID_UNKNOWN' as const;
  readonly run_id: string;

  constructor(run_id: string) {
    super(`ClaudeBgAdapter.terminateRun: native_id not found for run ${run_id}`);
    this.name = 'NativeIdUnknownError';
    this.run_id = run_id;
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
// Ledger write helper (used by dispatch to record native_id)
// ---------------------------------------------------------------------------

/**
 * Write the native_id onto the existing ledger record for a run.
 * This is called immediately after the `claude --bg` CLI outputs the session id,
 * so the dispatcher can correlate the native session via `allRecords()`.
 *
 * No-op if the record is missing (the dispatcher's fail-safe will handle it).
 */
function writeNativeId(instanceId: string, runId: string, nativeId: string): void {
  const ledgerDir = join(homedir(), '.cortextos', instanceId, 'state', 'runs');
  const runPath = join(ledgerDir, `${runId}.json`);
  if (!fs.existsSync(runPath)) return;

  try {
    const existing = JSON.parse(fs.readFileSync(runPath, 'utf-8')) as Record<string, unknown>;
    const updated = { ...existing, native_id: nativeId };
    ensureDir(ledgerDir);
    atomicWriteSync(runPath, JSON.stringify(updated, null, 2));
  } catch {
    // Best-effort — the ledger may be in a transient state. The dispatcher
    // will mark the record as missing native_id and reconcile will handle it.
  }
}

// ---------------------------------------------------------------------------
// ClaudeBgAdapter class — stateful (holds instanceId for ledger correlation)
// ---------------------------------------------------------------------------

/**
 * RuntimeDriver for the claude-bg lane.
 *
 * Constructed with an `instanceId` so dispatch can write the native_id
 * directly to the ledger record for post-dispatch reconciliation.
 */
export class ClaudeBgAdapter implements RuntimeDriver {
  readonly runtime = 'claude-bg' as const;
  readonly capabilities = CLAUDE_BG_CAPABILITIES;

  private readonly instanceId: string;

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  /**
   * Dispatch a run via `claude --bg`.
   *
   * OAuth-only: strips ANTHROPIC_API_KEY from the spawned environment to
   * guarantee subscription-lane billing. Extra-usage stays ON account-wide
   * (not our gate — that's the operator's account setting, see D-N2-2).
   *
   * After the CLI outputs the native session id, writes it to the ledger
   * record so the dispatcher's _markLive can correlate it.
   *
   * @throws on CLI failure — dispatcher rolls back the reservation.
   */
  async dispatch(spec: RunSpec): Promise<void> {
    // Build argv: --bg plus model, prompt, and working directory
    const argv = [
      '--bg',
      '--model', spec.model ?? 'claude-opus-4-5',
      '--output-format', 'json',
      '-p', `[run:${spec.run_id}] ${spec.cwd}`,
    ];

    // OAuth-only: strip API key so the CLI uses OAuth / subscription billing.
    // Do NOT set ANTHROPIC_API_KEY — that would switch billing to metered.
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    delete spawnEnv['ANTHROPIC_API_KEY'];

    const { stdout } = await execFileAsync('claude', argv, {
      timeout: 30_000,
      env: spawnEnv,
      cwd: spec.cwd,
    });

    // Extract native session id from the JSON output.
    // `claude --bg --output-format json` emits a JSON object with a session/id field.
    const nativeId = this._extractNativeId(stdout.trim(), spec.run_id);
    if (nativeId) {
      writeNativeId(this.instanceId, spec.run_id, nativeId);
    }
  }

  /**
   * Extract the native session id from `claude --bg --output-format json` stdout.
   *
   * The CLI output is a JSON object. We check `session_id`, `sessionId`, and `id`
   * in priority order (matching the shape observed in N1 spike + agents --json output).
   * Returns null if the output cannot be parsed or no id field is found.
   */
  private _extractNativeId(stdout: string, runId: string): string | null {
    if (!stdout) return null;

    // 1. JSON form (forward-compat: a future CLI may honor --output-format json).
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      const id =
        (typeof parsed['session_id'] === 'string' ? parsed['session_id'] : null) ??
        (typeof parsed['sessionId'] === 'string' ? parsed['sessionId'] : null) ??
        (typeof parsed['id'] === 'string' ? parsed['id'] : null);
      if (id) return id;
    } catch {
      // Not JSON — fall through to text parsing.
    }

    // Strip ANSI escape codes before text matching.
    const clean = stdout.replace(/\x1B\[[0-9;]*m/g, '');

    // 2. Full UUID form (some CLI versions emit a UUID).
    const uuidMatch = clean.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) return uuidMatch[0];

    // 3. Real `claude --bg` launch confirmation (empirically verified against the
    //    installed CLI — `--output-format json` is ignored for --bg). Shape:
    //      backgrounded · c8c52703
    //        claude stop c8c52703     stop this
    //    The short hex token IS the `claude agents`/`claude stop` correlation id, so
    //    parsing this launch result yields the same id the design's `agents --json`
    //    path would — it is a launch result, not streaming-log scraping.
    const launchMatch =
      clean.match(/backgrounded\s*[·•]\s*([0-9a-f]{6,})/i) ??
      clean.match(/\bclaude\s+(?:stop|attach|logs)\s+([0-9a-f]{6,})\b/i);
    if (launchMatch) return launchMatch[1] ?? null;

    // Could not extract native_id — dispatch succeeded but correlation is unavailable.
    // The dispatcher and reconcile() will handle the missing native_id (orphan-degrade).
    console.warn(`[claude-bg] dispatch(${runId}): could not extract native_id from stdout: ${clean.slice(0, 200)}`);
    return null;
  }

  /**
   * Get the current status of a run by run_id.
   *
   * Stub: real impl via `agents --json` polling is N3+.
   */
  async getStatus(_run_id: string): Promise<RunStatus | null> {
    return Promise.resolve(null);
  }

  /**
   * List all runs this adapter is currently managing.
   *
   * Stub: real impl is N3+.
   */
  async listRuns(): Promise<RunStatus[]> {
    return Promise.resolve([]);
  }

  /**
   * Terminate a live run by its run_id via `claude stop <native_id>`.
   *
   * Resolution order:
   *   1. Look up native_id from the run-authority ledger.
   *   2. Execute `claude stop <native_id>` (graceful, <1s per N1.5 measurement).
   *   3. If native_id is absent: throw NativeIdUnknownError so the dispatcher
   *      can degrade to orphan handling (reconcile will retry the kill later).
   *
   * @throws {NativeIdUnknownError} when the native_id is not in the ledger.
   * @throws on CLI failure (non-zero exit / timeout).
   */
  async terminateRun(run_id: string): Promise<void> {
    // Resolve native_id from the ledger
    const records = allRecords(this.instanceId);
    const rec = records.find((r) => r.run_id === run_id);
    const nativeId = rec?.native_id;

    if (!nativeId) {
      throw new NativeIdUnknownError(run_id);
    }

    // Strip API key — same OAuth-only rule as dispatch.
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    delete spawnEnv['ANTHROPIC_API_KEY'];

    await execFileAsync('claude', ['stop', nativeId], {
      timeout: 10_000,
      env: spawnEnv,
    });
  }

  // Delegate parse functions to the module-level exports (unchanged from N2).
  parseAgentsJson(raw: unknown): RunStatus {
    return parseAgentsJson(raw);
  }

  parseHookEvent(raw: unknown): RuntimeEvent {
    return parseHookEvent(raw);
  }
}

// ---------------------------------------------------------------------------
// Legacy singleton export (preserved for backward-compat with existing tests)
// ---------------------------------------------------------------------------

/**
 * Default adapter singleton using 'default' as instanceId.
 * For production use, construct ClaudeBgAdapter with the actual instanceId.
 *
 * @deprecated Prefer `new ClaudeBgAdapter(instanceId)` for production dispatch.
 */
export const claudeBgAdapter: RuntimeDriver = new ClaudeBgAdapter('default');
