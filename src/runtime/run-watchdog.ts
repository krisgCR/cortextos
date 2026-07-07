/**
 * src/runtime/run-watchdog.ts
 *
 * Central watchdog for the Phase 0a Autonomy Contract (Task 3.1 deadline,
 * Task 3.2 stall). Runs alongside the runtime-boundary observer loop and
 * issues typed cancels through the SAME guarded primitive every other
 * caller uses — `RuntimeDispatcher.cancelRun()` — never a second kill path
 * (coordination invariant, see WORK.md).
 *
 * ---------------------------------------------------------------------------
 * Task 3.1 — deadline sweep. SHIPPED DISABLED BY DEFAULT
 * (`CTX_RUN_DEADLINE_ENABLED` unset/!=='1') — H2. `deadline_at` is persisted
 * on every run AT RESERVE TIME (`reserveDispatch` in run-authority.ts), but
 * no caller plumbs a per-run `RunSpec.deadline` override today (not
 * `spawnWorker`, not `/api/dispatch`, no CLI flag) — so a hard 1h kill on
 * every run was reachable in code but not tunable per-run, false-killing
 * legitimate long autonomous work. Default-OFF until per-run deadline
 * plumbing lands (tracked as a fast-follow in WORK.md Known Limitations).
 * ---------------------------------------------------------------------------
 * Task 3.2 — stall sweep. SHIPPED DISABLED BY DEFAULT (`CTX_RUN_STALL_ENABLED`
 * unset/!=='1').
 *
 * Investigation (Fragile Assumption #4): a reliable per-run "last real
 * activity" timestamp does not exist anywhere in the current event surface:
 *   - `RuntimeDriver.parseHookEvent()` produces a `RuntimeEvent` with a
 *     `timestamp` field, but it is a pure parser — nothing in the daemon
 *     ever calls it or persists its output to a queryable per-run stream
 *     (grepped: only call sites are the adapters' own `parseHookEvent`
 *     methods and the one stub in agent-manager.ts's PTY driver scaffold;
 *     no hook receiver invokes it).
 *   - The workflow journal lines parsed by `workflow-observer.ts`
 *     (`JournalLine`) carry no timestamp field at all — `parseWorkflowJournal`
 *     cannot derive per-event times even in principle.
 *   - `RunRecord.heartbeat` is bumped by control-plane operations
 *     (`touchHeartbeat`, `reconcile`, `reserveDispatch`, `releaseDispatch`)
 *     — i.e. observer/ledger WRITE time, not source activity. Using it as
 *     the stall signal is exactly the "reads poll-write time (never fires)"
 *     failure mode called out in Fragile Assumption #4.
 *
 * Rather than false-kill on a fabricated signal, the stall sweep is built
 * as a pluggable `ActivitySource` and shipped with `NO_ACTIVITY_SIGNAL_SOURCE`
 * as the production default — it returns `undefined` for every run, which
 * `runStallSweep` treats as "no signal, never stall". This makes flipping
 * `CTX_RUN_STALL_ENABLED=1` inert (not dangerous) until a real adapter-side
 * heartbeat/event stream lands (tracked as a fast-follow in WORK.md Known
 * Limitations) and a real `ActivitySource` is wired in its place.
 */

import type { CancelReason } from '../types/index.js';
import { allRecords, type RunRecord } from './run-authority.js';
import type { RuntimeDispatcher } from './dispatcher.js';

/** Default stall window (10 minutes) — overridable via CTX_RUN_STALL_MS. */
const DEFAULT_RUN_STALL_MS = 600_000;

/** Default watchdog poll interval — overridable via CTX_RUN_WATCHDOG_MS. */
const DEFAULT_RUN_WATCHDOG_MS = 5_000;

/** Ledger states from which a run may still be cancelled. */
const CANCELLABLE_STATES = new Set<RunRecord['state']>(['pending', 'dispatching', 'live']);

// ---------------------------------------------------------------------------
// Activity source (Task 3.2 pluggability)
// ---------------------------------------------------------------------------

/**
 * Resolves the most recent REAL activity timestamp for a run, or `undefined`
 * if no such signal is available. `undefined` is a first-class "unknown" —
 * `runStallSweep` never stalls a run it has no real signal for.
 */
export interface ActivitySource {
  lastActivityAt(run: RunRecord): string | undefined;
}

/**
 * Production default (see module doc). No adapter today emits a persisted,
 * queryable per-run activity/heartbeat stream, so this always returns
 * `undefined` — the honest "we don't know" answer, not a fabricated one.
 */
export const NO_ACTIVITY_SIGNAL_SOURCE: ActivitySource = {
  lastActivityAt: () => undefined,
};

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

/** run_id + the CancelReason the sweep attempted for it. */
export interface WatchdogSweepResult {
  run_id: string;
  reason: CancelReason;
}

/**
 * Task 3.1 — wall-clock deadline sweep.
 *
 * For every cancellable run whose persisted `deadline_at` has passed and
 * which has no cancel intent recorded yet, calls `dispatcher.cancelRun(id,
 * 'deadline')` — the single guarded cancel primitive (first-reason-wins,
 * idempotent). Returns the run_ids this call actually caused to start
 * cancelling (a concurrent cancel that already won the race is not counted).
 *
 * Gated by `enabled` (default: `CTX_RUN_DEADLINE_ENABLED === '1'`) — H2.
 * Default-OFF: no per-run deadline override is reachable yet, so a blanket
 * 1h kill on every run is not a safe default. When disabled, this is a
 * guaranteed no-op — it does not even read the ledger.
 */
export async function runDeadlineSweep(
  dispatcher: RuntimeDispatcher,
  instanceId: string,
  now: Date = new Date(),
  enabled: boolean = process.env['CTX_RUN_DEADLINE_ENABLED'] === '1',
): Promise<WatchdogSweepResult[]> {
  if (!enabled) return [];

  const results: WatchdogSweepResult[] = [];
  const records = allRecords(instanceId);

  for (const rec of records) {
    if (!CANCELLABLE_STATES.has(rec.state)) continue;
    if (rec.cancel_reason !== undefined) continue; // already cancelling/cancelled
    if (!rec.deadline_at) continue;
    if (now.getTime() <= new Date(rec.deadline_at).getTime()) continue;

    await dispatcher.cancelRun(rec.run_id, 'deadline');

    const after = allRecords(instanceId).find((r) => r.run_id === rec.run_id);
    if (after?.cancel_reason === 'deadline') {
      results.push({ run_id: rec.run_id, reason: 'deadline' });
    }
  }

  return results;
}

/**
 * Task 3.2 — stall sweep (conservative; disabled by default).
 *
 * Gated by `opts.enabled` (falls back to `CTX_RUN_STALL_ENABLED === '1'`).
 * When disabled, this is a guaranteed no-op — it does not even read the
 * ledger. When enabled, a run is stalled only when `opts.activitySource`
 * (default: `NO_ACTIVITY_SIGNAL_SOURCE`) returns a real timestamp AND that
 * timestamp is older than the stall window; a run with no known activity
 * timestamp is never touched.
 */
export async function runStallSweep(
  dispatcher: RuntimeDispatcher,
  instanceId: string,
  opts: {
    now?: Date;
    activitySource?: ActivitySource;
    stallMs?: number;
    enabled?: boolean;
  } = {},
): Promise<WatchdogSweepResult[]> {
  const enabled = opts.enabled ?? process.env['CTX_RUN_STALL_ENABLED'] === '1';
  if (!enabled) return [];

  const now = opts.now ?? new Date();
  const activitySource = opts.activitySource ?? NO_ACTIVITY_SIGNAL_SOURCE;
  const stallMs =
    opts.stallMs ?? parseInt(process.env['CTX_RUN_STALL_MS'] ?? String(DEFAULT_RUN_STALL_MS), 10);

  const results: WatchdogSweepResult[] = [];
  const records = allRecords(instanceId);

  for (const rec of records) {
    if (!CANCELLABLE_STATES.has(rec.state)) continue;
    if (rec.cancel_reason !== undefined) continue; // already cancelling/cancelled

    const lastActivity = activitySource.lastActivityAt(rec);
    if (lastActivity === undefined) continue; // no real signal — never stall

    if (now.getTime() - new Date(lastActivity).getTime() <= stallMs) continue;

    await dispatcher.cancelRun(rec.run_id, 'stall');

    const after = allRecords(instanceId).find((r) => r.run_id === rec.run_id);
    if (after?.cancel_reason === 'stall') {
      results.push({ run_id: rec.run_id, reason: 'stall' });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Loop wiring (mirrors runtime-observer.ts's startRuntimeObserver shape)
// ---------------------------------------------------------------------------

/**
 * Start the watchdog on an interval: runs the deadline sweep every tick and
 * the stall sweep every tick (a guaranteed no-op unless explicitly enabled).
 * Returns a stop function — call it to clear the interval. Idempotent per
 * call site: callers (AgentManager) are responsible for their own start/stop
 * idempotency guard, matching the runtime-observer loop pattern.
 */
export function startRunWatchdogLoop(
  dispatcher: RuntimeDispatcher,
  instanceId: string,
  intervalMs: number = DEFAULT_RUN_WATCHDOG_MS,
): () => void {
  const tick = () => {
    void runDeadlineSweep(dispatcher, instanceId).catch((err: unknown) => {
      console.error('[run-watchdog] deadline sweep error:', err);
    });
    void runStallSweep(dispatcher, instanceId).catch((err: unknown) => {
      console.error('[run-watchdog] stall sweep error:', err);
    });
  };

  tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}
