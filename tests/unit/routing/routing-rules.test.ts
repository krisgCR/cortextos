import { describe, it, expect } from 'vitest';
import { matchRule } from '../../../src/routing/routing-rules';
import { FLOOR_MAP } from '../../../src/routing';
import { validateEventCategory } from '../../../src/utils/validate';
import type { RoutingRule } from '../../../src/routing/routing-rules';
import type { Role, Tier } from '../../../src/routing/types';

const TIER_ORDER: Tier[] = ['haiku', 'sonnet', 'opus'];

describe('matchRule', () => {
  const rules: RoutingRule[] = [
    { taskPattern: /security audit/i, tier: 'opus', reason: 'security work → opus' },
    { taskPattern: /list/i, role: 'explore', tier: 'haiku', reason: 'trivial explore → haiku' },
    { taskPattern: /list/i, tier: 'sonnet', reason: 'list tasks → sonnet for other roles' },
  ];

  it('returns null when no rules match', () => {
    expect(matchRule('implement feature', 'implement', rules)).toBeNull();
    expect(matchRule('', 'implement', rules)).toBeNull();
  });

  it('first matching rule wins', () => {
    // security audit matches the first rule, not anything else
    const match = matchRule('run a security audit now', 'review', rules);
    expect(match).toBeDefined();
    expect(match!.tier).toBe('opus');
    expect(match!.reason).toBe('security work → opus');
  });

  it('role-specific rule applies only to matching role', () => {
    // 'list' + role=explore → haiku rule
    const exploreMatch = matchRule('list all agents', 'explore', rules);
    expect(exploreMatch?.tier).toBe('haiku');

    // 'list' + role=implement → falls through to the third rule (no role filter, sonnet)
    const implementMatch = matchRule('list all agents', 'implement', rules);
    expect(implementMatch?.tier).toBe('sonnet');
  });

  it('role-agnostic rule matches any role', () => {
    for (const role of ['implement', 'plan', 'orchestrate', 'review'] as Role[]) {
      const match = matchRule('run a security audit', role, rules);
      expect(match?.tier).toBe('opus');
    }
  });

  it('returns null for role-specific rule when role does not match', () => {
    // The explore-specific list rule should NOT match for 'plan' role when a lower-priority
    // non-role rule also doesn't match the task
    const noMatch = matchRule('something completely different', 'explore', rules);
    expect(noMatch).toBeNull();
  });

  it('platform-only rule sets platform without specifying tier', () => {
    const platformRules: RoutingRule[] = [
      { taskPattern: /batch/, platform: 'codex', reason: 'batch → codex' },
    ];
    const match = matchRule('batch transform all logs', 'implement', platformRules);
    expect(match).toBeDefined();
    expect(match!.platform).toBe('codex');
    expect(match!.tier).toBeUndefined();
  });
});

describe('override respects floor — enforcement at call site', () => {
  it('FLOOR_MAP provides the floor for clamping at call site', () => {
    // matchRule itself does NOT clamp — that's the call site's responsibility.
    // This test documents the convention by checking FLOOR_MAP is available.
    const haiku_floor = FLOOR_MAP['explore'];
    const sonnet_floor = FLOOR_MAP['implement'];
    const opus_floor = FLOOR_MAP['plan'];

    expect(haiku_floor).toBe('haiku');
    expect(sonnet_floor).toBe('sonnet');
    expect(opus_floor).toBe('opus');

    // Illustrate: a rule returning 'haiku' for 'implement' would be below floor.
    // The call site should clamp it to 'sonnet'. matchRule just returns the rule as-is.
    const belowFloorRules: RoutingRule[] = [
      { taskPattern: /.*/, tier: 'haiku' },
    ];
    const match = matchRule('any task', 'implement', belowFloorRules);
    expect(match?.tier).toBe('haiku'); // matchRule returns raw tier; call site clamps

    // Simulate what call site would do:
    const floor = FLOOR_MAP['implement']!;
    const ruleTier = match!.tier!;
    const effective = TIER_ORDER.indexOf(ruleTier) >= TIER_ORDER.indexOf(floor)
      ? ruleTier
      : floor;
    expect(effective).toBe('sonnet'); // clamped to floor
  });
});

describe('routing event-category validity', () => {
  it("'routing' is a valid event category per the bus validator", () => {
    expect(() => validateEventCategory('routing')).not.toThrow();
  });

  it("all standard categories still validate", () => {
    const cats = ['action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval'];
    for (const cat of cats) {
      expect(() => validateEventCategory(cat)).not.toThrow();
    }
  });

  it("invalid category still throws", () => {
    expect(() => validateEventCategory('not-a-real-category')).toThrow();
  });
});
