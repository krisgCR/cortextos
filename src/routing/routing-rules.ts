import type { Platform, Role, Tier } from './types.js';

export interface RoutingRule {
  /** Regex tested against the task description. */
  taskPattern: RegExp;
  /** If set, rule only applies when the agent's role matches. */
  role?: Role;
  /** If set, forces this platform for the matched task. */
  platform?: Platform;
  /** If set, forces this tier for the matched task (clamped to ≥ floor at call site). */
  tier?: Tier;
  /** Human-readable explanation surfaced in routing bus events. */
  reason?: string;
}

/**
 * Find the first rule whose taskPattern matches `task` and whose role (if set) matches `role`.
 * Returns null if no rule matches.
 *
 * Rules are evaluated in array order — put higher-priority rules first.
 * A match overrides bandit/default but is still clamped to ≥ floor(role) at the call site.
 */
export function matchRule(task: string, role: Role, rules: RoutingRule[]): RoutingRule | null {
  for (const rule of rules) {
    if (rule.role !== undefined && rule.role !== role) continue;
    if (rule.taskPattern.test(task)) return rule;
  }
  return null;
}
