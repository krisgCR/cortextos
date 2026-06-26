'use client';

// cortextOS Dashboard - DispatchesView client island (N4)
// Accepts initial snapshot from RSC, subscribes to 'run' and 'team' SSE events for live updates.
// Phase B.2: adds cancel-team button + DispatchDialog.

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RunStateBadge } from '@/components/shared/run-state-badge';
import { TeamCancelBadge } from '@/components/shared/team-cancel-badge';
import { DispatchDialog } from '@/components/dispatch/dispatch-dialog';
import type { DispatchStatus } from '@/components/dispatch/dispatch-dialog';
import { useSSE } from '@/hooks/use-sse';
import { computeRollups } from '@/lib/data/dispatch-rollup';
import type { TeamRollup } from '@/lib/data/dispatch-rollup';
import type { RunRow, TeamRow, SSEEvent } from '@/lib/types';

// ---- Helpers ----

function formatTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ---- RunCard ----

interface RunCardProps {
  run: RunRow;
}

function RunCard({ run }: RunCardProps) {
  return (
    <div className="flex items-center gap-3 py-1.5 text-sm border-b last:border-b-0">
      <span className="font-mono text-xs text-muted-foreground truncate min-w-0 flex-1">
        {run.run_id}
      </span>
      {run.lane && (
        <span className="text-xs text-muted-foreground shrink-0">{run.lane}</span>
      )}
      <RunStateBadge state={run.state ?? 'unknown'} className="shrink-0" />
    </div>
  );
}

// ---- CancelTeamButton ----

interface CancelTeamButtonProps {
  teamId: string;
  liveCount: number;
}

function CancelTeamButton({ teamId, liveCount }: CancelTeamButtonProps) {
  const [status, setStatus] = useState<'idle' | 'confirming' | 'loading' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleCancel() {
    if (status === 'confirming') {
      // User confirmed — send request
      setStatus('loading');
      try {
        const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/cancel`, {
          method: 'POST',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `Cancel failed (${res.status})`);
        }
        setStatus('done');
        // SSE will update live-run counts as the daemon processes cancellations
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
        setStatus('error');
      }
    } else {
      setStatus('confirming');
    }
  }

  if (status === 'done') {
    return (
      <span className="text-xs text-muted-foreground italic">Cancel requested</span>
    );
  }

  if (status === 'error') {
    return (
      <span className="text-xs text-destructive">{errorMsg}</span>
    );
  }

  if (status === 'confirming') {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">
          Cancel {liveCount} live run{liveCount !== 1 ? 's' : ''}?
        </span>
        <Button
          size="sm"
          variant="destructive"
          className="h-6 px-2 text-xs"
          onClick={handleCancel}
        >
          Confirm
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          onClick={() => setStatus('idle')}
        >
          Back
        </Button>
      </div>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-6 px-2 text-xs"
      onClick={handleCancel}
      disabled={status === 'loading' || liveCount === 0}
    >
      {status === 'loading' ? 'Cancelling…' : 'Cancel team'}
    </Button>
  );
}

// ---- TeamSection ----

interface TeamSectionProps {
  rollup: TeamRollup;
}

function TeamSection({ rollup }: TeamSectionProps) {
  const teamLabel = rollup.team_id === '' ? 'Ungrouped' : rollup.team_id;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono text-xs text-muted-foreground truncate">{teamLabel}</span>
            <TeamCancelBadge
              cancelGeneration={rollup.cancel_generation}
              lastCancelAt={rollup.last_cancel_at}
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground">
              {rollup.liveCount} live
            </span>
            {/* Only show cancel button for real teams (not the ungrouped sentinel) */}
            {rollup.team_id !== '' && (
              <CancelTeamButton teamId={rollup.team_id} liveCount={rollup.liveCount} />
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Budget rollup */}
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>Reserved: <span className="text-foreground font-mono">{formatTokens(rollup.reserved)}</span></span>
          <span>Spent: <span className="text-foreground font-mono">{formatTokens(rollup.spentEstimate)}</span></span>
        </div>

        {/* Run list */}
        {rollup.runs.length > 0 ? (
          <div className="rounded-md border bg-muted/30 px-2 py-0.5">
            {rollup.runs.map((run) => (
              <RunCard key={run.run_id} run={run} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">No runs in this team.</p>
        )}
      </CardContent>
    </Card>
  );
}

// ---- DispatchesView: main client island ----

interface Props {
  initialRuns: RunRow[];
  initialTeams: TeamRow[];
  initialRollups: TeamRollup[];
  dispatchStatus: DispatchStatus | null;
}

export function DispatchesView({ initialRuns, initialTeams, initialRollups, dispatchStatus }: Props) {
  const [runs, setRuns] = useState<RunRow[]>(initialRuns);
  const [teams, setTeams] = useState<TeamRow[]>(initialTeams);
  const [dispatchDialogOpen, setDispatchDialogOpen] = useState(false);

  // Re-derive rollups whenever runs or teams change
  const rollups = computeRollups(runs, teams);

  const { isConnected } = useSSE({
    filter: (e: SSEEvent) => e.type === 'run' || e.type === 'team',
    onEvent: (event: SSEEvent) => {
      if (event.type === 'run') {
        const record = event.data as unknown as RunRow;
        if (!record?.run_id) return;
        setRuns((prev) => {
          const idx = prev.findIndex((r) => r.run_id === record.run_id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = record;
            return next;
          }
          return [record, ...prev];
        });
      } else if (event.type === 'team') {
        const record = event.data as unknown as TeamRow;
        if (!record?.team_id) return;
        setTeams((prev) => {
          const idx = prev.findIndex((t) => t.team_id === record.team_id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = record;
            return next;
          }
          return [record, ...prev];
        });
      }
    },
  });

  // Reflect prop updates (e.g. router refresh) without losing live additions
  useEffect(() => {
    setRuns((prev) => {
      const initialMap = new Map(initialRuns.map((r) => [r.run_id, r]));
      const liveOnly = prev.filter((r) => !initialMap.has(r.run_id));
      return [...initialRuns, ...liveOnly];
    });
  }, [initialRuns]);

  useEffect(() => {
    setTeams((prev) => {
      const initialMap = new Map(initialTeams.map((t) => [t.team_id, t]));
      const liveOnly = prev.filter((t) => !initialMap.has(t.team_id));
      return [...initialTeams, ...liveOnly];
    });
  }, [initialTeams]);

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
        <p className="text-sm font-medium text-muted-foreground">No dispatch runs yet.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Dispatched runs will appear here as they are created.
        </p>
        <span
          className={`mt-4 inline-block h-2 w-2 rounded-full ${
            isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-yellow-500'
          }`}
          title={isConnected ? 'Listening for updates' : 'Reconnecting…'}
        />
        <Button
          className="mt-4"
          size="sm"
          onClick={() => setDispatchDialogOpen(true)}
          disabled={dispatchStatus?.enabled === false}
        >
          Dispatch run
        </Button>
        <DispatchDialog
          open={dispatchDialogOpen}
          onOpenChange={setDispatchDialogOpen}
          rollups={rollups}
          dispatchStatus={dispatchStatus}
          onDispatched={() => setDispatchDialogOpen(false)}
        />
      </div>
    );
  }

  const totalLive = rollups.reduce((sum, r) => sum + r.liveCount, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className={`h-2 w-2 rounded-full ${
            isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-yellow-500'
          }`}
          title={isConnected ? 'Live' : 'Reconnecting…'}
        />
        <span>{isConnected ? 'Live' : 'Reconnecting…'}</span>
        <span className="ml-auto">
          {totalLive} live · {runs.length} total run{runs.length !== 1 ? 's' : ''}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          onClick={() => setDispatchDialogOpen(true)}
          disabled={dispatchStatus?.enabled === false}
        >
          + Dispatch run
        </Button>
      </div>

      {rollups.map((rollup) => (
        <TeamSection key={rollup.team_id} rollup={rollup} />
      ))}

      <DispatchDialog
        open={dispatchDialogOpen}
        onOpenChange={setDispatchDialogOpen}
        rollups={rollups}
        dispatchStatus={dispatchStatus}
        onDispatched={() => setDispatchDialogOpen(false)}
      />
    </div>
  );
}
