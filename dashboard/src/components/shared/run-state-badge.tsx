// cortextOS Dashboard - Run state badge (N4 dispatches)
// Displays the state of a dispatch run ledger entry.

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

const LABEL: Record<string, string> = {
  pending: 'Pending',
  dispatching: 'Dispatching',
  live: 'Live',
  done: 'Done',
  failed: 'Failed',
  orphaned: 'Orphaned',
  _fallback: 'Unknown',
};

const CLASSES: Record<string, string> = {
  pending: 'bg-muted text-muted-foreground border-border',
  dispatching: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  live: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  done: 'bg-muted text-muted-foreground border-border',
  failed: 'bg-destructive/10 text-destructive border-destructive/30',
  orphaned: 'bg-orange-500/10 text-orange-600 border-orange-500/30',
  _fallback: 'bg-muted text-muted-foreground border-border',
};

export interface RunStateBadgeProps {
  state: string;
  className?: string;
}

export function RunStateBadge({ state, className }: RunStateBadgeProps) {
  const label = LABEL[state] ?? LABEL['_fallback'];
  const colorClass = CLASSES[state] ?? CLASSES['_fallback'];

  return (
    <Badge
      variant="outline"
      className={cn('font-normal', colorClass, className)}
    >
      {label}
    </Badge>
  );
}
