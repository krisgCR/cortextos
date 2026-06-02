'use client';

import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { resolveAgentEmoji } from '@/lib/agent-emoji';

export interface AgentAvatarProps {
  name: string;
  emoji?: string;
  size?: 'sm' | 'md' | 'lg';
  showName?: boolean;
  className?: string;
}

const sizeMap = {
  sm: 'sm' as const,
  md: 'default' as const,
  lg: 'lg' as const,
};

export function AgentAvatar({
  name,
  emoji,
  size = 'md',
  showName = false,
  className,
}: AgentAvatarProps) {
  const glyph = resolveAgentEmoji(name, emoji);

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Avatar size={sizeMap[size]}>
        <AvatarFallback>{glyph}</AvatarFallback>
      </Avatar>
      {showName && (
        <span className="text-sm font-medium">{name}</span>
      )}
    </span>
  );
}
