import { logEvent } from '../bus/event.js';
import type { BusPaths } from '../types/index.js';
import type { ComplexityBucket, Platform, Role, Tier } from './types.js';

export interface RoutingDecisionMeta {
  decisionId: string;
  role: Role;
  bucket: ComplexityBucket;
  tier: Tier;
  platform: Platform;
  /** Claude model slug, or null for non-Claude platforms (Codex runs `codex exec` with no model arg). */
  model: string | null;
  reason: string;
  calibrated: boolean;
}

/**
 * Emit a `routing.decision` event on the bus.
 * Uses the existing watcher/SSE pipeline — no new dashboard route needed.
 */
export function logRoutingDecision(
  paths: BusPaths,
  agentName: string,
  org: string,
  meta: RoutingDecisionMeta,
): void {
  logEvent(paths, agentName, org, 'routing', 'routing.decision', 'info', meta as unknown as Record<string, unknown>);
}
