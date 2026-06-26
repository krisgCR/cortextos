// cortextOS Dashboard - N4 dispatch run ledger accessor
// Reads from the SQLite runs/teams tables populated by syncRun()/syncTeam() in sync.ts.
// Pure rollup computation lives in dispatch-rollup.ts (client-safe, no server-only imports).

import { db } from '../db';
import { IPCClient } from '../ipc-client';
import type { RunRow, TeamRow } from '../types';
import { computeRollups } from './dispatch-rollup';
import type { DispatchStatus } from '@/components/dispatch/dispatch-dialog';

// Re-export pure helpers so existing callers continue to import from this module.
export { LIVE_RUN_STATES, computeRollups } from './dispatch-rollup';
export type { TeamRollup } from './dispatch-rollup';

/**
 * Get all dispatch run records, ordered by most recently updated.
 */
export function getDispatches(): RunRow[] {
  return db
    .prepare('SELECT * FROM runs ORDER BY updated_at DESC')
    .all() as RunRow[];
}

/**
 * Get all team records, ordered by most recently updated.
 */
export function getTeams(): TeamRow[] {
  return db
    .prepare('SELECT * FROM teams ORDER BY updated_at DESC')
    .all() as TeamRow[];
}

/**
 * Compute per-team rollups with budget totals and live-run counts.
 *
 * Reads from the SQLite DB; delegates computation to computeRollups().
 */
export function getTeamRollups() {
  const runs = db.prepare('SELECT * FROM runs').all() as RunRow[];
  const teams = db.prepare('SELECT * FROM teams').all() as TeamRow[];
  return computeRollups(runs, teams);
}

/**
 * Get the current dispatch system status from the daemon via IPC.
 *
 * Returns null when the daemon is not running or the IPC call fails.
 * Used by RSC pages to pass the kill-switch state to the DispatchDialog.
 */
export async function getDispatchStatus(): Promise<DispatchStatus | null> {
  try {
    const ipc = new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default');
    if (!(await ipc.isDaemonRunning())) return null;
    const resp = await ipc.send({ type: 'dispatch-status' });
    if (!resp.success) return null;
    // The daemon sends DispatchStatusPayload flat at resp.data (not nested under .dispatch)
    const d = resp.data as DispatchStatus;
    if (!d || typeof d.enabled !== 'boolean') return null;
    return {
      enabled: d.enabled,
      teamBudgetTokens: d.teamBudgetTokens ?? 0,
      maxConcurrency: d.maxConcurrency ?? 1,
      fleetMaxConcurrent: d.fleetMaxConcurrent ?? 1,
    };
  } catch {
    return null;
  }
}
