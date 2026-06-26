/**
 * Durable run-authority ledger for the D24 runtime-boundary protocol.
 *
 * cortextOS is a RECONCILER over the native supervisor — it never owns PIDs.
 * Leases and epochs are ownership claims reconciled against `claude agents --json`
 * snapshots, not OS process handles.
 *
 * Each run is stored as an individual JSON file at:
 *   {ctxRoot}/state/runs/{run_id}.json
 *
 * where `ctxRoot` = `~/.cortextos/{instanceId}`.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { RunLease } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

const DEFAULT_FLEET_MAX_CONCURRENT = 50;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Shape stored per-run in the ledger (one JSON file per run_id). */
export interface RunRecord {
  run_id: string;
  idempotency_key: string;
  /** claude agents --json id, set on adoption */
  native_id?: string;
  /** Absolute path to the worktree held by this run, if any */
  worktree?: string;
  fencing_token?: string;
  epoch: number;
  /** ISO-8601 timestamp of the most recent heartbeat */
  heartbeat: string;
  state: 'pending' | 'live' | 'done' | 'orphaned' | 'dispatching' | 'failed';
  /** Team identifier for N4 budget + concurrency grouping */
  team_id?: string;
  /** Runtime lane this run was dispatched on (e.g. 'claude-bg', 'pty') */
  lane?: 'claude-bg' | 'pty' | string;
  /** Tokens reserved for this run at dispatch time (from RunSpec.budget_tokens) */
  budget_reserved?: number;
  /** Estimated tokens spent by this run (updated by runtime observer) */
  budget_spent_estimate?: number;
  /** Team cancel generation at the time this run was reserved (N4 cancel guard) */
  cancel_generation?: number;
}

/**
 * Per-team durable state stored at:
 *   {ctxRoot}/state/teams/{team_id}.json
 *
 * Holds team-level monotonic counters that cannot be derived from run records
 * alone (e.g. cancel_generation must survive across run lifecycles).
 */
export interface TeamState {
  team_id: string;
  /** Monotonically increasing cancel generation. Bumped by cancelTeam(). */
  cancel_generation: number;
  /** ISO-8601 timestamp of the last cancel bump */
  last_cancel_at?: string;
}

/** Entry shape from `claude agents list --json` output */
export interface AgentsJsonEntry {
  id: string;
  state: string;
  sessionId?: string;
  cwd?: string;
}

/** Summary returned by `reconcile` */
export interface ReconcileReport {
  readopted: string[];
  orphaned: string[];
  completed: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the ledger directory for an instance.
 * Mirrors `resolvePaths` but avoids the agent-name requirement since the
 * run-authority ledger is instance-scoped, not agent-scoped.
 */
function ledgerDir(instanceId: string): string {
  return join(homedir(), '.cortextos', instanceId, 'state', 'runs');
}

function runPath(instanceId: string, runId: string): string {
  return join(ledgerDir(instanceId), `${runId}.json`);
}

function readRecord(instanceId: string, runId: string): RunRecord | null {
  const p = runPath(instanceId, runId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as RunRecord;
}

function writeRecord(instanceId: string, record: RunRecord): void {
  ensureDir(ledgerDir(instanceId));
  atomicWriteSync(runPath(instanceId, record.run_id), JSON.stringify(record, null, 2));
}

// ---------------------------------------------------------------------------
// Team state helpers
// ---------------------------------------------------------------------------

function teamDir(instanceId: string): string {
  return join(homedir(), '.cortextos', instanceId, 'state', 'teams');
}

function teamPath(instanceId: string, teamId: string): string {
  return join(teamDir(instanceId), `${teamId}.json`);
}

function readTeamState(instanceId: string, teamId: string): TeamState {
  const p = teamPath(instanceId, teamId);
  if (!fs.existsSync(p)) {
    return { team_id: teamId, cancel_generation: 0 };
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as TeamState;
}

function writeTeamState(instanceId: string, state: TeamState): void {
  ensureDir(teamDir(instanceId));
  atomicWriteSync(teamPath(instanceId, state.team_id), JSON.stringify(state, null, 2));
}

export function allRecords(instanceId: string): RunRecord[] {
  const dir = ledgerDir(instanceId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(join(dir, f), 'utf-8')) as RunRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is RunRecord => r !== null);
}

// ---------------------------------------------------------------------------
// Public errors
// ---------------------------------------------------------------------------

/** Thrown when a worktree lease is already held by another run. */
export class RunLeaseConflictError extends Error {
  worktree: string;
  holderRunId: string;

  constructor(worktree: string, holderRunId: string) {
    super(
      `Worktree lease conflict: "${worktree}" is already held by run ${holderRunId}`,
    );
    this.name = 'RunLeaseConflictError';
    this.worktree = worktree;
    this.holderRunId = holderRunId;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a run_id + idempotency_key to the ledger before the run is dispatched.
 *
 * Idempotent on (idempotency_key): if a record with the same key already exists
 * for this run_id, this is a no-op. This ensures safe retry on transient failures.
 */
export function recordRun(
  instanceId: string,
  spec: { run_id: string; idempotency_key: string },
): void {
  const existing = readRecord(instanceId, spec.run_id);
  if (existing) {
    if (existing.idempotency_key === spec.idempotency_key) {
      // Idempotent — same key already recorded for this run_id.
      return;
    }
    // Different key on same run_id is a caller error — refuse to overwrite a live record.
    throw new Error(
      `recordRun: run_id ${spec.run_id} already registered with a different idempotency_key`,
    );
  }

  const record: RunRecord = {
    run_id: spec.run_id,
    idempotency_key: spec.idempotency_key,
    epoch: 0,
    heartbeat: new Date().toISOString(),
    state: 'pending',
  };

  writeRecord(instanceId, record);
}

/**
 * Acquire an exclusive worktree lease for a run.
 *
 * Scans the entire ledger for live records holding the requested worktree.
 * If one is found, throws `RunLeaseConflictError`.
 * Otherwise, writes lease fields (fencing_token, epoch 1) and returns a `RunLease`.
 */
export function acquireLease(
  instanceId: string,
  worktree: string,
  runId: string,
): RunLease {
  const records = allRecords(instanceId);
  for (const r of records) {
    if (r.worktree === worktree && r.state === 'live' && r.run_id !== runId) {
      throw new RunLeaseConflictError(worktree, r.run_id);
    }
  }

  const fencingToken = randomUUID();
  const now = new Date().toISOString();

  // Read the existing record if any; merge lease fields on top.
  const existing = readRecord(instanceId, runId);
  const record: RunRecord = existing
    ? {
        ...existing,
        worktree,
        fencing_token: fencingToken,
        epoch: 1,
        heartbeat: now,
        state: 'live',
      }
    : {
        run_id: runId,
        idempotency_key: runId, // fallback — recordRun should be called first
        worktree,
        fencing_token: fencingToken,
        epoch: 1,
        heartbeat: now,
        state: 'live',
      };

  writeRecord(instanceId, record);

  return {
    worktree,
    holderRunId: runId,
    fencingToken,
    epoch: 1,
    heartbeat: now,
  };
}

/**
 * Update the heartbeat timestamp for a live run.
 *
 * If `nativeId` differs from the stored `native_id`, the epoch is incremented
 * (re-adoption: the run was picked up by a new native session).
 */
export function touchHeartbeat(
  instanceId: string,
  runId: string,
  nativeId?: string,
): void {
  const existing = readRecord(instanceId, runId);
  if (!existing) {
    throw new Error(`touchHeartbeat: run ${runId} not found in ledger`);
  }

  const now = new Date().toISOString();
  const epochBump =
    nativeId !== undefined && existing.native_id !== undefined && existing.native_id !== nativeId
      ? 1
      : 0;

  const updated: RunRecord = {
    ...existing,
    heartbeat: now,
    epoch: existing.epoch + epochBump,
    ...(nativeId !== undefined ? { native_id: nativeId } : {}),
  };

  writeRecord(instanceId, updated);
}

/**
 * Reconcile the ledger against a `claude agents list --json` snapshot.
 *
 * For each record in the ledger:
 * - If a matching entry exists in the snapshot and is live-ish → re-adopt (state='live', epoch++, heartbeat now).
 * - If a matching entry exists and is done/stopped → mark completed.
 * - If no matching entry and the run was 'live' → mark orphaned.
 *
 * Returns a report of which run_ids were readopted, completed, or orphaned.
 */
export function reconcile(
  instanceId: string,
  agentsSnapshot: AgentsJsonEntry[],
): ReconcileReport {
  const records = allRecords(instanceId);
  const report: ReconcileReport = { readopted: [], orphaned: [], completed: [] };

  const liveStates = new Set(['working', 'running', 'blocked', 'active', 'started']);
  const doneStates = new Set(['done', 'stopped', 'failed', 'completed', 'exited']);

  for (const record of records) {
    // Match by native_id or by run_id === agentsSnapshot[i].sessionId
    const match = agentsSnapshot.find(
      (e) =>
        (record.native_id && e.id === record.native_id) ||
        e.sessionId === record.run_id,
    );

    if (match) {
      if (liveStates.has(match.state)) {
        // Re-adopt: run is still live in the native supervisor.
        const updated: RunRecord = {
          ...record,
          state: 'live',
          native_id: match.id,
          epoch: record.epoch + 1,
          heartbeat: new Date().toISOString(),
        };
        writeRecord(instanceId, updated);
        report.readopted.push(record.run_id);
      } else if (doneStates.has(match.state)) {
        // Completed: native run has finished.
        const updated: RunRecord = {
          ...record,
          state: 'done',
          heartbeat: new Date().toISOString(),
        };
        writeRecord(instanceId, updated);
        report.completed.push(record.run_id);
      }
      // If the state is something else entirely, leave the record unchanged.
    } else if (record.state === 'live') {
      // Was live but not found in snapshot → orphaned.
      const updated: RunRecord = {
        ...record,
        state: 'orphaned',
        heartbeat: new Date().toISOString(),
      };
      writeRecord(instanceId, updated);
      report.orphaned.push(record.run_id);
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// N4 — Team-scoped dispatch authority helpers
// ---------------------------------------------------------------------------

/**
 * Result type for reserveDispatch: discriminated union so callers never need
 * to catch for refusals — only genuine ledger I/O failures throw.
 */
export type ReserveResult =
  | { ok: true; record: RunRecord }
  | { ok: false; reason: string };

/**
 * Atomically reserve a team budget slot and concurrency lease for a new run.
 *
 * Checks (in order):
 *   1. Idempotency — if a record with this idempotency_key already exists for
 *      the team, return it without double-reserving.
 *   2. Cancel gate — if the team's cancel_generation > 0, refuse (cancel in effect).
 *   3. Concurrency cap — if the team has >= maxConcurrency live+dispatching runs,
 *      refuse.
 *   4. Budget ceiling — if adding budget_tokens to the team's current
 *      budget_reserved would exceed teamBudgetTokens, refuse.
 *   5. On pass: write a new record in state 'dispatching' with budget_reserved
 *      set to the requested budget_tokens.
 *
 * NEVER throws on refusal — only throws on genuine ledger I/O failure.
 * Serialization: all reads + write happen synchronously under Node's single-
 * threaded event loop, providing the atomicity guarantee documented in WORK.md §4.
 */
export function reserveDispatch(
  instanceId: string,
  opts: {
    run_id: string;
    idempotency_key: string;
    team_id?: string;
    lane: string;
    budget_tokens: number;
    teamBudgetTokens: number;
    maxConcurrency: number;
  },
): ReserveResult {
  const teamId = opts.team_id ?? `solo:${opts.run_id}`;

  // --- 1. Idempotency check ---
  const allRecs = allRecords(instanceId);
  const existing = allRecs.find(
    (r) => r.idempotency_key === opts.idempotency_key && r.team_id === teamId,
  );
  if (existing) {
    return { ok: true, record: existing };
  }

  // --- 2. Cancel gate ---
  const teamState = readTeamState(instanceId, teamId);
  if (teamState.cancel_generation > 0) {
    return {
      ok: false,
      reason: `team ${teamId} has active cancel (generation=${teamState.cancel_generation}); dispatch refused`,
    };
  }

  // --- 3. Concurrency cap ---
  const liveStates = new Set<RunRecord['state']>(['dispatching', 'live', 'pending']);
  const teamRecs = allRecs.filter((r) => r.team_id === teamId);
  const liveCount = teamRecs.filter((r) => liveStates.has(r.state)).length;
  if (liveCount >= opts.maxConcurrency) {
    return {
      ok: false,
      reason: `team ${teamId} is at concurrency cap (${liveCount}/${opts.maxConcurrency}); dispatch refused`,
    };
  }

  // --- 4. Budget ceiling ---
  const reservedSum = teamRecs
    .filter((r) => liveStates.has(r.state))
    .reduce((acc, r) => acc + (r.budget_reserved ?? 0), 0);
  if (reservedSum + opts.budget_tokens > opts.teamBudgetTokens) {
    return {
      ok: false,
      reason: `team ${teamId} budget ceiling would be exceeded (reserved=${reservedSum}+${opts.budget_tokens} > limit=${opts.teamBudgetTokens}); dispatch refused`,
    };
  }

  // --- 5. Global fleet cap — prevents solo-team bypass ---
  const fleetMax = parseInt(process.env.CTX_FLEET_MAX_CONCURRENT ?? String(DEFAULT_FLEET_MAX_CONCURRENT), 10);
  const fleetLiveCount = allRecs.filter(r => liveStates.has(r.state)).length;
  if (fleetLiveCount >= fleetMax) {
    return { ok: false, reason: 'fleet-cap-exceeded' };
  }

  // --- 6. Write dispatching record ---
  const record: RunRecord = {
    run_id: opts.run_id,
    idempotency_key: opts.idempotency_key,
    epoch: 0,
    heartbeat: new Date().toISOString(),
    state: 'dispatching',
    team_id: teamId,
    lane: opts.lane,
    budget_reserved: opts.budget_tokens,
    budget_spent_estimate: 0,
    cancel_generation: teamState.cancel_generation,
  };

  writeRecord(instanceId, record);
  return { ok: true, record };
}

/**
 * Release the budget reservation and set the final state for a run.
 *
 * Called on:
 *   - Adapter failure rollback (finalState='failed')
 *   - Normal completion (finalState='done')
 *
 * Zeroes budget_reserved so the team's reserved sum decreases immediately.
 * If the run is not found, this is a no-op (idempotent on missing records).
 */
export function releaseDispatch(
  instanceId: string,
  runId: string,
  finalState: 'failed' | 'done',
): void {
  const existing = readRecord(instanceId, runId);
  if (!existing) return;

  const updated: RunRecord = {
    ...existing,
    state: finalState,
    budget_reserved: 0,
    heartbeat: new Date().toISOString(),
  };

  writeRecord(instanceId, updated);
}

/**
 * Atomically increment the team's cancel generation.
 *
 * Bumping the cancel_generation is the durable gate that halts all further
 * dispatches for the team — reserveDispatch checks cancel_generation > 0 and
 * refuses. This write does NOT depend on `claude stop` completing; it is the
 * bounded, fail-closed part of cancel-team.
 *
 * Returns the new (post-bump) cancel generation.
 */
export function bumpCancelGeneration(instanceId: string, teamId: string): number {
  const current = readTeamState(instanceId, teamId);
  const next = current.cancel_generation + 1;
  const updated: TeamState = {
    ...current,
    cancel_generation: next,
    last_cancel_at: new Date().toISOString(),
  };
  writeTeamState(instanceId, updated);
  return next;
}

/**
 * Check whether the team's cancel generation still matches the expected value.
 *
 * Used by dispatchers that captured the generation at reserve time and need to
 * confirm no cancel has been issued since then (e.g. after an async adapter
 * call returns).
 *
 * Returns true if the current generation equals expected (no cancel issued since
 * reserve); false if a cancel has been bumped (generation diverged).
 */
export function assertGeneration(
  instanceId: string,
  teamId: string,
  expected: number,
): boolean {
  const current = readTeamState(instanceId, teamId);
  return current.cancel_generation === expected;
}

/**
 * Return aggregate team metrics derived from allRecords + team state.
 *
 * `reserved`: sum of budget_reserved for live/dispatching/pending runs.
 * `spentEstimate`: sum of budget_spent_estimate for all team runs.
 * `liveCount`: number of runs in live/dispatching/pending states.
 * `cancelGeneration`: current team cancel generation from TeamState.
 */
export function teamRollup(
  instanceId: string,
  teamId: string,
): { reserved: number; spentEstimate: number; liveCount: number; cancelGeneration: number } {
  const allRecs = allRecords(instanceId);
  const teamRecs = allRecs.filter((r) => r.team_id === teamId);
  const liveStates = new Set<RunRecord['state']>(['dispatching', 'live', 'pending']);

  const liveRecs = teamRecs.filter((r) => liveStates.has(r.state));
  const reserved = liveRecs.reduce((acc, r) => acc + (r.budget_reserved ?? 0), 0);
  const spentEstimate = teamRecs.reduce((acc, r) => acc + (r.budget_spent_estimate ?? 0), 0);
  const cancelGeneration = readTeamState(instanceId, teamId).cancel_generation;

  return { reserved, spentEstimate, liveCount: liveRecs.length, cancelGeneration };
}
