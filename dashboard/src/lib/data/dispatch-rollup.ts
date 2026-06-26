// cortextOS Dashboard - Pure dispatch rollup computation (N4)
// No server-only imports — safe for client components and server components alike.
// Exported from here so dispatches-view.tsx (client) and dispatches.ts (server) can share the logic.

import type { RunRow, TeamRow } from '@/lib/types';

// Run states that count as "live" for budget reservation and concurrency.
// Mirrors LIVE_RUN_STATES from dispatches.ts and run-authority.ts teamRollup().
export const LIVE_RUN_STATES = ['dispatching', 'live', 'pending'] as const;

/**
 * Computed per-team budget and concurrency rollup.
 *
 * Runs with no team_id are aggregated into a sentinel bucket with
 * team_id='' so callers always receive a flat TeamRollup[] without nulls.
 */
export interface TeamRollup {
  team_id: string;
  cancel_generation: number;
  last_cancel_at: string | null;
  /** Sum of budget_reserved for LIVE_RUN_STATES runs only. */
  reserved: number;
  /** Sum of budget_spent_estimate for ALL runs in this team (not just live). */
  spentEstimate: number;
  /** Count of runs whose state is in LIVE_RUN_STATES. */
  liveCount: number;
  runs: RunRow[];
}

/**
 * Pure rollup computation from run and team arrays.
 *
 * No DB access — accepts arrays directly so it works in both server and client contexts.
 *
 * reserved      = sum(budget_reserved) for runs where state IN LIVE_RUN_STATES
 * spentEstimate = sum(budget_spent_estimate) for ALL runs in the team
 * liveCount     = count(runs) where state IN LIVE_RUN_STATES
 *
 * Runs with no team_id are placed in a sentinel bucket (team_id='').
 */
export function computeRollups(runs: RunRow[], teams: TeamRow[]): TeamRollup[] {
  const isLive = (state: string | null): boolean =>
    (LIVE_RUN_STATES as readonly string[]).includes(state ?? '');

  // Group runs by team_id
  const byTeam = new Map<string, RunRow[]>();
  const ungrouped: RunRow[] = [];

  for (const run of runs) {
    if (!run.team_id) {
      ungrouped.push(run);
      continue;
    }
    const existing = byTeam.get(run.team_id) ?? [];
    existing.push(run);
    byTeam.set(run.team_id, existing);
  }

  const rollups: TeamRollup[] = [];

  for (const [team_id, teamRuns] of byTeam) {
    const teamRecord = teams.find((t) => t.team_id === team_id);
    const liveRuns = teamRuns.filter((r) => isLive(r.state));

    rollups.push({
      team_id,
      cancel_generation: teamRecord?.cancel_generation ?? 0,
      last_cancel_at: teamRecord?.last_cancel_at ?? null,
      reserved: liveRuns.reduce((sum, r) => sum + (r.budget_reserved ?? 0), 0),
      spentEstimate: teamRuns.reduce((sum, r) => sum + (r.budget_spent_estimate ?? 0), 0),
      liveCount: liveRuns.length,
      runs: teamRuns,
    });
  }

  // Sentinel bucket for ungrouped runs (no team_id)
  if (ungrouped.length > 0) {
    const liveUngrouped = ungrouped.filter((r) => isLive(r.state));
    rollups.push({
      team_id: '',
      cancel_generation: 0,
      last_cancel_at: null,
      reserved: liveUngrouped.reduce((sum, r) => sum + (r.budget_reserved ?? 0), 0),
      spentEstimate: ungrouped.reduce((sum, r) => sum + (r.budget_spent_estimate ?? 0), 0),
      liveCount: liveUngrouped.length,
      runs: ungrouped,
    });
  }

  return rollups;
}
