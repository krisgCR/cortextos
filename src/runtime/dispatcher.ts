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
import type { CancelReason, RunSpec, RuntimeDriver } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import {
  allRecords,
  assertGeneration,
  bumpCancelGeneration,
  reconcile,
  releaseDispatch,
  reserveDispatch,
  requestCancel,
  reissueTermination,
  type AgentsJsonEntry,
  type ReconcileReport,
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
        | 'cancelled-during-dispatch'
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
        deadline: spec.deadline,
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

    // --- 3.5. Run-scoped cancel fence re-check (Task 2.2 / Fragile Assumption #2) ---
    // adapter.dispatch() may have taken arbitrarily long (a real `claude --bg`
    // spawn). If a run-scoped cancel was requested for THIS run while dispatch
    // was in flight, the native session that was just created must be
    // terminated immediately — it must never be marked live.
    //
    // Two races land here, both signalled by cancel_requested_at being set:
    //   (a) cancelRun raced AFTER native_id existed: it already called
    //       adapter.terminateRun and finalized 'done' — this check's
    //       terminateRun call is a harmless best-effort mop-up (state is
    //       already terminal, so no further ledger write happens on failure).
    //   (b) cancelRun raced BEFORE native_id existed: it saw no native_id to
    //       terminate and finalized 'done' immediately — the native session
    //       dispatch() just created was never killed. This check is the ONLY
    //       place that closes that gap.
    const postDispatchRecord = allRecords(this.instanceId).find((r) => r.run_id === run_id);
    if (postDispatchRecord?.cancel_requested_at !== undefined) {
      const alreadyTerminal =
        postDispatchRecord.state === 'done' ||
        postDispatchRecord.state === 'failed' ||
        postDispatchRecord.state === 'orphaned';
      try {
        await adapter.terminateRun(run_id);
        if (!alreadyTerminal) {
          try { releaseDispatch(this.instanceId, run_id, 'done'); } catch { /* best-effort */ }
        }
      } catch {
        if (!alreadyTerminal) {
          // Only this call is finalizing the record — safe to mark orphaned.
          this._markOrphaned(run_id);
        } else {
          // The record already settled terminal via cancelRun's own path;
          // this mop-up terminateRun call failed too. Not fatal to the
          // ledger (already terminal), but the native session was never
          // confirmed killed — surface it loudly (possible leaked session).
          console.warn(
            `[dispatcher] launch(): mop-up terminateRun failed for already-terminal run ${run_id} — possible leaked native session.`,
          );
        }
      }
      // Reason precedence: cancelTeam bumps the team generation AND (via the
      // shared cancelRun primitive) sets this run's cancel fence, so both trip
      // here. A stale generation is the coarser, established team-level signal —
      // report 'stale-generation' so cancelTeam's observable contract is
      // unchanged. A pure run-scoped cancelRun (generation still current)
      // reports 'cancelled-during-dispatch'.
      const generationCurrent = assertGeneration(this.instanceId, teamId, capturedGeneration);
      return {
        accepted: false,
        reason: generationCurrent ? 'cancelled-during-dispatch' : 'stale-generation',
      };
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
   * Cancel a single run by run_id — the run-scoped counterpart to
   * `cancelTeam` (Phase 0a / Fragile Assumption #1). Deliberately does NOT
   * touch any team's `cancel_generation`; a run-scoped cancel must never
   * cancel or refuse-dispatch for the whole team.
   *
   * Order of operations:
   *   1. `requestCancel` — guarded ledger CAS recording `cancel_requested_at`
   *      / `cancel_reason`. No-op (first-reason-wins) if the run is already
   *      terminal, or a concurrent cancel already won the race — in either
   *      case this call returns without touching the adapter.
   *   2. No `native_id` yet → nothing to terminate; finalize immediately via
   *      `releaseDispatch(..., 'done')` (cancel_reason carries through the
   *      spread — a distinct terminal representation from a bare 'done').
   *      NOTE: a run cancelled while still `dispatching` (native_id not yet
   *      assigned) can still have its adapter call land AFTER this — that
   *      race is fenced by Task 2.2 (launch()'s post-dispatch re-check), not
   *      here.
   *   3. `native_id` present → best-effort `adapter.terminateRun`. On
   *      success, finalize via `releaseDispatch(..., 'done')`. On failure or
   *      a missing adapter, mark orphaned via the same `_markOrphaned` path
   *      used by `cancelTeam`'s failure branch — never a duplicate transition.
   */
  async cancelRun(run_id: string, reason: CancelReason): Promise<void> {
    const intent = requestCancel(this.instanceId, run_id, reason);
    if (!intent || !intent.applied) {
      // Not found, already terminal, or a concurrent cancel already claimed
      // the transition — first-reason-wins, nothing further for this call.
      return;
    }

    const rec = intent.record;

    if (!rec.native_id) {
      try {
        releaseDispatch(this.instanceId, run_id, 'done');
      } catch {
        // Best-effort — ledger I/O failure here is non-fatal.
      }
      return;
    }

    const adapterKey = rec.lane ?? 'claude-bg';
    const adapter = this.lanes.get(adapterKey) ?? this.lanes.get('claude-bg');
    if (!adapter) {
      this._markOrphaned(run_id);
      return;
    }

    try {
      await adapter.terminateRun(run_id);
      try {
        releaseDispatch(this.instanceId, run_id, 'done');
      } catch {
        // Best-effort release after successful terminate.
      }
    } catch {
      // terminateRun failed or timed out — mark orphaned for reconcile.
      this._markOrphaned(run_id);
    }
  }

  /**
   * Cancel all live runs belonging to a team.
   *
   * D25 order of operations:
   *   1. bumpCancelGeneration — durable halt; blocks all future dispatches for
   *      this team. Does NOT depend on claude stop completing.
   *   2. Collect all live records for the team.
   *   3. Delegate per-run cancellation to `cancelRun` — the SAME guarded
   *      primitive a single-run cancel uses. No duplicated transition logic.
   *
   * Resolves after the termination sweep; does not block on slow kills.
   */
  async cancelTeam(team_id: string): Promise<void> {
    // 1. Durable halt — must happen before any per-run cancel.
    bumpCancelGeneration(this.instanceId, team_id);

    // 2. Collect live team records.
    const liveStates = new Set<RunRecord['state']>(['dispatching', 'live', 'pending']);
    const teamRecs = allRecords(this.instanceId).filter(
      (r) => r.team_id === team_id && liveStates.has(r.state),
    );

    // 3. Delegate to cancelRun for each live run.
    const cancellations = teamRecs.map((rec) => this.cancelRun(rec.run_id, 'human'));

    await Promise.allSettled(cancellations);
  }

  /**
   * Boot-time reconciliation (Task 2.3 / Fragile Assumption #3).
   *
   * Delegates the pure ledger stickiness check to
   * `run-authority.reconcile()` — a terminal or mid-cancel record is never
   * re-adopted as live — then re-issues termination, via THIS dispatcher's
   * own adapter lanes, for every run_id flagged `stickyLive` (a record the
   * native supervisor still reports live though the ledger says otherwise).
   *
   * This is the sole caller of `reissueTermination`, preserving the
   * coordination invariant that every terminate call funnels through the
   * dispatcher's guarded lane resolution — no adapter is ever called
   * directly outside this class.
   *
   * Best-effort per run_id: a missing/unresolvable adapter for a sticky
   * record is skipped (not thrown) — the next reconcile pass will retry it.
   *
   * @param snapshotReliable  Whether `agentsSnapshot` reflects a genuine CLI
   *   read (default true). Pass `false` when the caller's discovery query
   *   itself failed/timed out (empty/degraded snapshot) — an unreliable
   *   snapshot must never mass-orphan every live run (H3); it is passed
   *   through to `reconcile()`, which leaves live records untouched instead.
   */
  async reconcileBoot(
    agentsSnapshot: AgentsJsonEntry[],
    snapshotReliable = true,
  ): Promise<ReconcileReport> {
    const report = reconcile(this.instanceId, agentsSnapshot, snapshotReliable);

    const escalations = report.stickyLive.map(async (runId) => {
      const rec = allRecords(this.instanceId).find((r) => r.run_id === runId);
      if (!rec) return;
      const adapterKey = rec.lane ?? 'claude-bg';
      const adapter = this.lanes.get(adapterKey) ?? this.lanes.get('claude-bg');
      if (!adapter) return; // no adapter to escalate through — next pass retries.

      await reissueTermination(this.instanceId, runId, {
        terminateRun: (id) => adapter.terminateRun(id),
        getStatus: async (id) => {
          const status = await adapter.getStatus(id);
          return status ? { state: status.state } : null;
        },
      });
    });

    await Promise.allSettled(escalations);
    return report;
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

  /**
   * Mark a run as orphaned (terminateRun failed; reconcile will follow up).
   *
   * Guard (M2): a record that has already settled into 'done' (a cleanly
   * finalized cancel/completion) must never be downgraded to 'orphaned' by a
   * later, unrelated terminate-failure. Only 'done' is protected here —
   * 'live'/'dispatching'/'failed' records may still be marked orphaned.
   * `reissueTermination` (run-authority.ts) is a deliberate exception: it
   * writes state:'orphaned' directly (not via this helper) for its
   * intentional done→orphaned-on-unconfirmed-death escalation path.
   */
  private _markOrphaned(runId: string): void {
    const rec = allRecords(this.instanceId).find((r) => r.run_id === runId);
    if (!rec) return;
    if (rec.state === 'done') return;

    const updated: RunRecord = {
      ...rec,
      state: 'orphaned',
      budget_reserved: 0,
      heartbeat: new Date().toISOString(),
    };
    writeRecord(this.instanceId, updated);
  }
}
