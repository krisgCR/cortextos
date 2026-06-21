import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { AgentRuntime } from '@/lib/types';

// AgentRuntime covers daemon-managed runtimes; RuntimeBoundaryRecord also uses
// 'claude-bg' | 'codex-exec' | 'unknown' — accept string to cover both.
export interface RuntimeBadgeProps {
  runtime: AgentRuntime | string;
  degraded?: boolean;
  className?: string;
}

const RUNTIME_LABEL: Record<string, string> = {
  'claude-code': 'Claude',
  'claude-bg': 'Claude BG',
  'codex-app-server': 'Codex',
  'codex-exec': 'Codex Exec',
  hermes: 'Hermes',
  unknown: 'Unknown',
};

const RUNTIME_CLASSES: Record<string, string> = {
  'claude-code': 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  'claude-bg': 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  'codex-app-server': 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  'codex-exec': 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  hermes: 'bg-violet-500/10 text-violet-600 border-violet-500/30',
  unknown: 'bg-muted text-muted-foreground border-border',
};

export function RuntimeBadge({ runtime, degraded = false, className }: RuntimeBadgeProps) {
  const label = RUNTIME_LABEL[runtime] ?? runtime;
  const colorClass = RUNTIME_CLASSES[runtime] ?? 'bg-muted text-muted-foreground border-border';

  return (
    <Badge
      variant="outline"
      className={cn(
        'font-normal gap-1',
        colorClass,
        degraded && 'border-yellow-500/50',
        className,
      )}
    >
      {label}
      {degraded && (
        <span className="text-yellow-500 font-medium" title="Degraded capability">
          ⚠
        </span>
      )}
    </Badge>
  );
}
