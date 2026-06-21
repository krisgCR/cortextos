'use client';

// cortextOS Dashboard - RuntimeTree client island (N3)
// Accepts initial snapshot from RSC, subscribes to 'runtime' SSE events for live updates.

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RuntimeBadge } from '@/components/shared/runtime-badge';
import { useSSE } from '@/hooks/use-sse';
import { buildRuntimeTree, isRecordDegraded, nativeViewPath } from '@/lib/runtime-tree';
import type { RuntimeBoundaryRecord, AgentNode, SSEEvent } from '@/lib/types';

// ---- AgentNodeRow: recursive tree renderer ----

interface AgentNodeRowProps {
  node: AgentNode;
  depth?: number;
}

function AgentNodeRow({ node, depth = 0 }: AgentNodeRowProps) {
  const stateColor: Record<AgentNode['state'], string> = {
    working: 'text-emerald-600',
    blocked: 'text-yellow-600',
    done: 'text-muted-foreground',
    failed: 'text-destructive',
    stopped: 'text-muted-foreground',
    unknown: 'text-muted-foreground',
  };

  return (
    <>
      <div
        className="flex items-center gap-2 py-0.5 text-sm"
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        {depth > 0 && (
          <span className="text-muted-foreground/40 shrink-0">└</span>
        )}
        <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded shrink-0">
          {node.id}
        </span>
        {node.label && node.label !== node.id && (
          <span className="truncate text-muted-foreground">{node.label}</span>
        )}
        <span className={`ml-auto text-xs shrink-0 ${stateColor[node.state] ?? ''}`}>
          {node.state}
        </span>
        {node.degraded && (
          <span className="text-yellow-500 text-xs shrink-0" title="Degraded">⚠</span>
        )}
      </div>
      {node.children.map((child) => (
        <AgentNodeRow key={child.id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

// ---- RuntimeCard: renders a single boundary record ----

interface RuntimeCardProps {
  record: RuntimeBoundaryRecord;
}

function RuntimeCard({ record }: RuntimeCardProps) {
  const tree = buildRuntimeTree(record);
  const degraded = isRecordDegraded(record);
  const viewPath = nativeViewPath(record.run_id);

  const stateLabel: Record<RuntimeBoundaryRecord['state'], string> = {
    working: 'Working',
    blocked: 'Blocked',
    done: 'Done',
    failed: 'Failed',
    stopped: 'Stopped',
    unknown: 'Unknown',
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <div className="flex items-center gap-2 min-w-0">
            <RuntimeBadge runtime={record.runtime} degraded={degraded} />
            <span className="font-mono text-xs text-muted-foreground truncate">
              {record.run_id}
            </span>
          </div>
          <span
            className={`text-xs shrink-0 ${
              record.state === 'working'
                ? 'text-emerald-600'
                : record.state === 'failed'
                ? 'text-destructive'
                : 'text-muted-foreground'
            }`}
          >
            {stateLabel[record.state]}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Agent tree */}
        {tree.length > 0 ? (
          <div className="rounded-md border bg-muted/30 px-2 py-1.5">
            {tree.map((node) => (
              <AgentNodeRow key={node.id} node={node} depth={0} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">No agent nodes reported.</p>
        )}

        {/* Native view deep-link (local FS path — not a URL) */}
        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">📂</span>
          <span className="font-mono break-all">{viewPath}</span>
        </div>

        {/* Timestamps */}
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span className="ml-auto">
            Updated: {new Date(record.updated_at).toLocaleTimeString()}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ---- RuntimeTree: main client island ----

interface RuntimeTreeProps {
  initialRuntimes: RuntimeBoundaryRecord[];
}

export function RuntimeTree({ initialRuntimes }: RuntimeTreeProps) {
  const [runtimes, setRuntimes] = useState<RuntimeBoundaryRecord[]>(initialRuntimes);

  const { isConnected } = useSSE({
    filter: (event: SSEEvent) => event.type === 'runtime',
    onEvent: (event: SSEEvent) => {
      // Each runtime SSE event carries the updated record in event.data
      const incoming = event.data as unknown as RuntimeBoundaryRecord;
      if (!incoming?.run_id) return;

      setRuntimes((prev) => {
        const idx = prev.findIndex((r) => r.run_id === incoming.run_id);
        if (idx === -1) {
          // New record — prepend
          return [incoming, ...prev];
        }
        // Update in place, preserve order
        const next = [...prev];
        next[idx] = incoming;
        return next;
      });
    },
  });

  // Reflect prop updates (e.g. router refresh) without losing live additions
  useEffect(() => {
    setRuntimes((prev) => {
      // Merge: initialRuntimes wins for existing run_ids; keep any live-only entries
      const initialMap = new Map(initialRuntimes.map((r) => [r.run_id, r]));
      const liveOnly = prev.filter((r) => !initialMap.has(r.run_id));
      return [...initialRuntimes, ...liveOnly];
    });
  }, [initialRuntimes]);

  if (runtimes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
        <p className="text-sm font-medium text-muted-foreground">No active runtimes.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Start an agent to see fleet activity here.
        </p>
        <span
          className={`mt-4 inline-block h-2 w-2 rounded-full ${
            isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-yellow-500'
          }`}
          title={isConnected ? 'Listening for updates' : 'Reconnecting…'}
        />
      </div>
    );
  }

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
        <span className="ml-auto">{runtimes.length} runtime{runtimes.length !== 1 ? 's' : ''}</span>
      </div>

      {runtimes.map((record) => (
        <RuntimeCard key={record.run_id} record={record} />
      ))}
    </div>
  );
}
