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

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Shape stored per-run in the ledger (one JSON file per run_id). */
interface RunRecord {
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
  state: 'pending' | 'live' | 'done' | 'orphaned';
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

function allRecords(instanceId: string): RunRecord[] {
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
