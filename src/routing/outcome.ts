import type { ComplexityBucket, ReviewerVerdict, Role, Tier } from './types.js';

export type { ReviewerVerdict };

export interface RoutingOutcome {
  decisionId: string;
  role: Role;
  bucket: ComplexityBucket;
  tier: Tier;
  success: boolean;
  /** Relative tier cost at decision time — used for cost-aware reward shaping. */
  cost: number;
  source: 'objective' | 'reviewer';
}

export interface ObjectiveSignal {
  exitCode?: number;
  testsPass?: boolean;
  buildPass?: boolean;
  crashed?: boolean;
  completedWithinBudget?: boolean;
  escalationNeeded?: boolean;
}

/**
 * Derive a RoutingOutcome from objective task signals.
 * Failure if: crashed, escalation needed, non-zero exit, tests/build failed.
 * All unspecified signals are ignored (treated as neutral).
 */
export function outcomeFromObjective(
  base: Omit<RoutingOutcome, 'success' | 'source'>,
  signal: ObjectiveSignal,
): RoutingOutcome {
  const success =
    !signal.crashed &&
    !signal.escalationNeeded &&
    (signal.exitCode === undefined || signal.exitCode === 0) &&
    (signal.testsPass === undefined || signal.testsPass) &&
    (signal.buildPass === undefined || signal.buildPass) &&
    (signal.completedWithinBudget === undefined || signal.completedWithinBudget);
  return { ...base, success, source: 'objective' };
}

/**
 * Blocking-only reviewer adapter.
 * critical → failure; concerns/lgtm → success.
 * Prevents the always-finds-something reviewer from dominating the reward signal.
 */
export function outcomeFromReviewer(
  base: Omit<RoutingOutcome, 'success' | 'source'>,
  verdict: ReviewerVerdict,
): RoutingOutcome {
  return { ...base, success: verdict !== 'critical', source: 'reviewer' };
}

/** Relative cost per tier (haiku=1, sonnet=3, opus=9). */
export const TIER_COST: Record<Tier, number> = {
  haiku: 1,
  sonnet: 3,
  opus: 9,
};

/**
 * Cost-aware reward weight.
 * Cheaper success → higher weight so the bandit learns to de-escalate.
 * Failures always weigh 1 (equal penalty regardless of tier cost).
 */
export function costShape(tier: Tier, success: boolean): number {
  if (!success) return 1;
  return 1 / (TIER_COST[tier] ?? 3);
}
