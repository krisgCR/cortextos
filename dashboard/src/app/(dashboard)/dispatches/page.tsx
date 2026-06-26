// cortextOS Dashboard - Dispatches (N4 dispatch/teams view) page
// Server component: fetches initial snapshot, delegates live updates to the client island.

import { getDispatches, getTeams, getTeamRollups, getDispatchStatus } from '@/lib/data/dispatches';
import { DispatchesView } from './dispatches-view';

export const dynamic = 'force-dynamic';

export default async function DispatchesPage() {
  const [runs, teams, rollups, dispatchStatus] = await Promise.all([
    Promise.resolve(getDispatches()),
    Promise.resolve(getTeams()),
    Promise.resolve(getTeamRollups()),
    getDispatchStatus(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dispatches</h1>
        <p className="text-sm text-muted-foreground">
          Live dispatch runs grouped by team — budgets, states, and cancel signals.
        </p>
      </div>

      <DispatchesView
        initialRuns={runs}
        initialTeams={teams}
        initialRollups={rollups}
        dispatchStatus={dispatchStatus}
      />
    </div>
  );
}
