// cortextOS Dashboard - Team cancel-state badge (N4 dispatches)
// Shows whether a team has been cancelled (cancel_generation > 0 or last_cancel_at set).

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

export interface TeamCancelBadgeProps {
  cancelGeneration: number;
  lastCancelAt: string | null;
  className?: string;
}

export function TeamCancelBadge({
  cancelGeneration,
  lastCancelAt,
  className,
}: TeamCancelBadgeProps) {
  const cancelled = cancelGeneration > 0 || lastCancelAt != null;

  return (
    <Badge
      variant="outline"
      className={cn(
        'font-normal',
        cancelled
          ? 'bg-red-500/10 text-red-600 border-red-500/30'
          : 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
        className,
      )}
    >
      {cancelled ? 'cancelled' : 'active'}
    </Badge>
  );
}
