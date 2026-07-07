// cortextOS Dashboard - Run cancel-reason badge (Task 3.4)
// Displays the typed terminal cancel reason for a dispatch run — sourced from
// the RunRecord ledger (state/runs/<run_id>.json) via the runs cache table's
// cancel_reason column, NOT derived from any other JSON blob.
// Cloned from components/shared/runtime-badge.tsx.

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

export interface RunCancelReasonBadgeProps {
  /** 'deadline' | 'stall' | 'human' | null — matches src/types/index.ts CancelReason. */
  cancelReason: string | null | undefined;
  className?: string;
}

const CANCEL_REASON_LABEL: Record<string, string> = {
  deadline: 'Cancelled: deadline',
  stall: 'Cancelled: stall',
  human: 'Cancelled: human',
};

const CANCEL_REASON_CLASSES: Record<string, string> = {
  deadline: 'bg-orange-500/10 text-orange-600 border-orange-500/30',
  stall: 'bg-yellow-500/10 text-yellow-700 border-yellow-500/30',
  human: 'bg-red-500/10 text-red-600 border-red-500/30',
};

/** Renders nothing when the run has no cancel_reason (not cancelled). */
export function RunCancelReasonBadge({ cancelReason, className }: RunCancelReasonBadgeProps) {
  if (!cancelReason) return null;

  const label = CANCEL_REASON_LABEL[cancelReason] ?? `Cancelled: ${cancelReason}`;
  const colorClass = CANCEL_REASON_CLASSES[cancelReason] ?? 'bg-muted text-muted-foreground border-border';

  return (
    <Badge variant="outline" className={cn('font-normal', colorClass, className)}>
      {label}
    </Badge>
  );
}
