/**
 * RuntimeDispatcher — the single guarded boundary between cortextOS and
 * native runtime adapters (D25 / N4).
 *
 * All dispatch attempts pass through this class. It enforces:
 *   - Kill-switch gate (CTX_N4_DISPATCH_ENABLED)
 *   - Budget ceiling (via reserveDispatch)
 *   - Concurrency cap (via reserveDispatch)
 *   - Cancel-generation fencing (via assertGeneration + bumpCancelGeneration)
 *   - Idempotency (via reserveDispatch idempotency_key check)
 *   - Fail-safe: any guard error → refuse, never reach the adapter
 *
 * The dispatcher does NOT own worktree isolation, heartbeat management,
 * or reconciliation — those live in run-authority and the observer.
 */

import { homedir } from 'os';
import { join } from 'path';
import type { RunSpec, RuntimeDriver } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import {
  allRecords,
  assertGeneration,
  bumpCancelGeneration,
  releaseDispatch,
  reserveDispatch,
  type RunRecord,
} from './run-authority.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DispatchResult =
  | { accepted: true; run_id: string; native_id?: string }
  | {
      accepted: false;
      reason:
        | 'dispatch-disabled'
        | 'guard-error'
        | 'at-cap'
        | 'over-budget'
        | 'cancel-in-effect'
        | 'stale-generation'
        | 'adapter-error'
        | string;
    };

export interface DispatchOpts {
  /** Token ceiling for the entire team (checked against all live reservations). */
  teamBudgetTokens: number;
  /**
   * Maximum concurrent live+dispatching+pending runs for the team.
   * Default: 20.
   */
  maxConcurrency?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers (module-private)
// ---------------------------------------------------------------------------

function runsDir(instanceId: string): string {
  return join(homedir(), '.cortextos', instanceId, 'state', 'runs');
}

function writeRecord(instanceId: string, record: RunRecord): void {
  const dir = runsDir(instanceId);
  ensureDir(dir);
  atomicWriteSync(join(dir, `${record.run_id}.json`), JSON.stringify(record, null, 2));
}

// ---------------------------------------------------------------------------
// RuntimeDispatcher
// ---------------------------------------------------------------------------

export class RuntimeDispatcher {
  private readonly instanceId: string;
  private readonly lanes: Map<string, RuntimeDriver>;

  /**
   * @param instanceId  cortextOS instance identifier (passed to run-authority helpers).
   * @param lanes       Map from runtime/lane name → RuntimeDriver. Should include
   *                    'claude-bg' as the default fallback lane.
   */
  constructor(instanceId: string, lanes: Map<string, RuntimeDriver>) {
    this.instanceId = instanceId;
    this.lanes = lanes;
  }

  /**
   * Reserve a dispatch slot synchronously (steps 1–2 only).
   *
   * Returns a DispatchResult FAST — no adapter spawn, no billing.
   * On accept, also returns the captured cancel_generation so the caller
   * can pass it to `launch()` for the mid-flight fence check.
   *
   * Transaction steps:
   *   1. Kill-switch — CTX_N4_DISPATCH_ENABLED === 'false' → refuse immediately.
   *   2. reserveDispatch — budget + concurrency + cancel + idempotency check.
   *      Any thrown error (I/O, etc.) → catch → refuse with reason:'guard-error'.
   *      The adapter is NEVER called on guard failure.
   */
  async reserve(
    spec: RunSpec,
    opts: DispatchOpts,
  ): Promise<DispatchResult & { _capturedGeneration?: number; _skipLaunch?: boolean }> {
    // --- 1. Kill-switch ---
    if (process.env['CTX_N4_DISPATCH_ENABLED'] === 'false') {
      return { accepted: false, reason: 'dispatch-disabled' };
    }

    // Resolve the adapter: prefer the spec's runtime, fall back to 'claude-bg'.
    const laneName = spec.runtime ?? 'claude-bg';
    const adapter = this.lanes.get(laneName) ?? this.lanes.get('claude-bg');
    if (!adapter) {
      return { accepted: false, reason: 'guard-error' };
    }

    const maxConcurrency = opts.maxConcurrency ?? 20;
    const budgetTokens = spec.budget_tokens ?? 0;

    // --- 2. Reserve (guard) ---
    let reserveResult;
    try {
      reserveResult = reserveDispatch(this.instanceId, {
        run_id: spec.run_id,
        idempotency_key: spec.idempotency_key,
        team_id: spec.team_id,
        lane: laneName,
        budget_tokens: budgetTokens,
        teamBudgetTokens: opts.teamBudgetTokens,
        maxConcurrency,
      });
    } catch {
      // Genuine ledger I/O failure — fail-safe: refuse without touching the adapter.
      return { accepted: false, reason: 'guard-error' };
    }

    if (!reserveResult.ok) {
      const raw = reserveResult.reason;
      let reason: string;
      if (raw.includes('cancel')) {
        reason = 'cancel-in-effect';
      } else if (raw.includes('fleet')) {
        // Must precede the generic 'cap' check — 'fleet-cap-exceeded' contains 'cap'.
        reason = 'fleet-cap-exceeded';
      } else if (raw.includes('cap')) {
        reason = 'at-cap';
      } else if (raw.includes('budget') || raw.includes('ceiling')) {
        reason = 'over-budget';
      } else {
        reason = raw;
      }
      return { accepted: false, reason };
    }

    // Idempotency short-circuit: if the record already exists and is in a
    // terminal-success state (live/done), the adapter was already called — return accepted.
    // _skipLaunch signals the dispatch() wrapper to skip the launch() call.
    const terminalSuccess = reserveResult.record.state === 'live' || reserveResult.record.state === 'done';
    if (reserveResult.record.state !== 'dispatching' && terminalSuccess) {
      return {
        accepted: true,
        run_id: reserveResult.record.run_id,
        _skipLaunch: true,
        ...(reserveResult.record.native_id ? { native_id: reserveResult.record.native_id } : {}),
      };
    }

    // Capture the generation at reserve time for the post-dispatch fencing check.
    const capturedGeneration = reserveResult.record.cancel_generation ?? 0;

    return { accepted: true, run_id: spec.run_id, _capturedGeneration: capturedGeneration };
  }

  /**
   * Launch the adapter after a successful `reserve()` call (steps 3–5).
   *
   * This is the slow/billed part. Fire-and-forget from the IPC handler;
   * awaited in the `dispatch()` backward-compat wrapper.
   *
   * Returns:
   *   - `null`            — success; run is now 'live'.
   *   - `DispatchResult`  — non-success; the result to propagate to the caller.
   *
   * Non-success paths (all release the reservation):
   *   - adapter-error  → { accepted: false, reason: 'adapter-error' }
   *   - stale-generation → { accepted: false, reason: 'stale-generation' }
   *   - no-adapter (guard error post-reserve) → { accepted: false, reason: 'guard-error' }
   *   - thrown exception → caught; behaves like adapter-error
   */
  async launch(
    spec: RunSpec,
    opts: DispatchOpts | undefined,
    run_id: string,
    capturedGeneration: number,
  ): Promise<DispatchResult | null> {
    const laneName = spec.runtime ?? 'claude-bg';
    const adapter = this.lanes.get(laneName) ?? this.lanes.get('claude-bg');
    if (!adapter) {
      // Guard error post-reserve — release and clean up.
      try { releaseDispatch(this.instanceId, run_id, 'failed'); } catch { /* best-effort */ }
      return { accepted: false, reason: 'guard-error' };
    }

    // Normalise team_id the same way reserveDispatch does internally.
    const teamId = spec.team_id ?? `solo:${spec.run_id}`;

    // --- 3. Adapter dispatch ---
    try {
      await adapter.dispatch(spec);
    } catch {
      // Adapter threw — roll back the reservation.
      try { releaseDispatch(this.instanceId, run_id, 'failed'); } catch { /* best-effort */ }
      return { accepted: false, reason: 'adapter-error' };
    }

    // --- 4. Generation re-check (mid-flight cancel guard) ---
    const generationOk = assertGeneration(this.instanceId, teamId, capturedGeneration);
    if (!generationOk) {
      // Team was cancelled while the adapter was running — kill the session.
      let terminateSucceeded = false;
      try {
        await adapter.terminateRun(run_id);
        terminateSucceeded = true;
      } catch {
        // terminateRun failed — mark orphaned so the reconcile loop can clean up.
        this._markOrphaned(run_id);
      }
      if (terminateSucceeded) {
        try { releaseDispatch(this.instanceId, run_id, 'failed'); } catch { /* best-effort */ }
      }
      return { accepted: false, reason: 'stale-generation' };
    }

    // --- 5. Mark live ---
    this._markLive(run_id);
    return null;
  }

  /**
   * Dispatch a run through the guarded boundary.
   *
   * Backward-compatible wrapper: calls reserve() then launch() sequentially.
   * Use this when the full transaction must complete before returning (e.g.,
   * direct dispatcher calls in tests and agent-manager.spawnWorker).
   *
   * For IPC handlers that must return fast, call reserve() + fire-and-forget launch().
   *
   * Transaction flow:
   *   1. Kill-switch — CTX_N4_DISPATCH_ENABLED === 'false' → refuse immediately.
   *   2. reserveDispatch — budget + concurrency + cancel + idempotency check.
   *      Any thrown error (I/O, etc.) → catch → refuse with reason:'guard-error'.
   *      The adapter is NEVER called on guard failure.
   *   3. Adapter dispatch — call lane adapter.dispatch(spec).
   *      On throw: releaseDispatch('failed') + return 'adapter-error'.
   *   4. Generation re-check — if team was cancelled mid-flight:
   *      terminateRun (best-effort) + releaseDispatch('failed') → 'stale-generation'.
   *   5. Mark the run 'live' in the ledger and return accepted.
   */
  async dispatch(spec: RunSpec, opts: DispatchOpts): Promise<DispatchResult> {
    const result = await this.reserve(spec, opts);
    if (result.accepted) {
      const capturedGeneration = result._capturedGeneration ?? 0;
      const skipLaunch = result._skipLaunch ?? false;
      // Strip internal fields before returning to callers.
      const { _capturedGeneration: _cg, _skipLaunch: _sl, ...cleanResult } = result;

      if (!skipLaunch) {
        // Not an idempotency short-circuit — run the adapter.
        const launchResult = await this.launch(spec, opts, result.run_id, capturedGeneration);
        if (launchResult !== null) {
          // launch() reported a non-success (adapter-error, stale-generation, guard-error).
          return launchResult;
        }
      }
      return cleanResult as DispatchResult;
    }
    const { _capturedGeneration: _cg, _skipLaunch: _sl, ...cleanResult } = result;
    return cleanResult as DispatchResult;
  }

  /**
   * Cancel all live runs belonging to a team.
   *
   * D25 order of operations:
   *   1. bumpCancelGeneration — durable halt; blocks all future dispatches for
   *      this team. Does NOT depend on claude stop completing.
   *   2. Collect all live records for the team.
   *   3. For each live record: call terminateRun on its lane adapter (best-effort).
   *      On throw: mark the record orphaned (reconcile will clean up later).
   *
   * Resolves after the termination sweep; does not block on slow kills.
   */
  async cancelTeam(team_id: string): Promise<void> {
    // 1. Durable halt — must happen before any terminateRun.
    bumpCancelGeneration(this.instanceId, team_id);

    // 2. Collect live team records.
    const liveStates = new Set<RunRecord['state']>(['dispatching', 'live', 'pending']);
    const teamRecs = allRecords(this.instanceId).filter(
      (r) => r.team_id === team_id && liveStates.has(r.state),
    );

    // 3. Best-effort terminate each live run.
    const terminations = teamRecs.map(async (rec) => {
      const adapterKey = rec.lane ?? 'claude-bg';
      const adapter = this.lanes.get(adapterKey) ?? this.lanes.get('claude-bg');
      if (!adapter) {
        this._markOrphaned(rec.run_id);
        return;
      }
      try {
        await adapter.terminateRun(rec.run_id);
        try {
          releaseDispatch(this.instanceId, rec.run_id, 'done');
        } catch {
          // Best-effort release after successful terminate.
        }
      } catch {
        // terminateRun failed or timed out — mark orphaned for reconcile.
        this._markOrphaned(rec.run_id);
      }
    });

    await Promise.allSettled(terminations);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Transition a run from 'dispatching' → 'live'. */
  private _markLive(runId: string, nativeId?: string): void {
    const rec = allRecords(this.instanceId).find((r) => r.run_id === runId);
    if (!rec) return;
    if (rec.state !== 'dispatching') return;

    const updated: RunRecord = {
      ...rec,
      state: 'live',
      heartbeat: new Date().toISOString(),
      ...(nativeId ? { native_id: nativeId } : {}),
    };
    writeRecord(this.instanceId, updated);
  }

  /** Mark a run as orphaned (terminateRun failed; reconcile will follow up). */
  private _markOrphaned(runId: string): void {
    const rec = allRecords(this.instanceId).find((r) => r.run_id === runId);
    if (!rec) return;

    const updated: RunRecord = {
      ...rec,
      state: 'orphaned',
      budget_reserved: 0,
      heartbeat: new Date().toISOString(),
    };
    writeRecord(this.instanceId, updated);
  }
}
