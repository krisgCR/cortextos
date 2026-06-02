export type { ComplexityBucket } from './types.js';
export type { Platform, Role, ReviewerVerdict, Tier } from './types.js';
export { BUCKET_SCHEME_VERSION, bucketOf } from './complexity.js';
export type { ObjectiveSignal, RoutingOutcome } from './outcome.js';
export { TIER_COST, costShape, outcomeFromObjective, outcomeFromReviewer } from './outcome.js';
export type { Bandit, BanditOptions, BanditStateSnapshot } from './tier-bandit.js';
export { DEFAULT_FLOOR_MAP, createBandit } from './tier-bandit.js';
export type { RuntimeClassification } from './runtime-dispatch.js';
export { classifyRuntime } from './runtime-dispatch.js';
export type { RoutingRule } from './routing-rules.js';
export { matchRule } from './routing-rules.js';
export type { RoutingDecisionMeta } from './bus-log.js';
export { logRoutingDecision } from './bus-log.js';
export type { CircuitBreakerOptions } from './circuit-breaker.js';
export { RuntimeCircuitBreaker } from './circuit-breaker.js';

import type { Platform, Role, Tier } from './types.js';

/** D18 static tier floor per role. The bandit can only ESCALATE above this. */
export const FLOOR_MAP: Record<Role, Tier> = {
  explore: 'haiku',
  research: 'haiku',
  implement: 'sonnet',
  plan: 'opus',
  orchestrate: 'opus',
  review: 'opus',
};

/** Single source of truth: tier → spawnable runtime + model. */
export const TIER_MODEL_MAP: Record<Tier, { platform: Platform; model: string }> = {
  haiku: { platform: 'claude', model: 'claude-haiku-4-5-20251001' },
  sonnet: { platform: 'claude', model: 'claude-sonnet-4-6' },
  opus: { platform: 'claude', model: 'claude-opus-4-8' },
};
