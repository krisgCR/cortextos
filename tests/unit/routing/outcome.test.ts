import { describe, it, expect } from 'vitest';
import {
  outcomeFromObjective,
  outcomeFromReviewer,
  costShape,
  TIER_COST,
} from '../../../src/routing/outcome';
import type { RoutingOutcome } from '../../../src/routing/outcome';

const base: Omit<RoutingOutcome, 'success' | 'source'> = {
  decisionId: 'test-001',
  role: 'implement',
  bucket: 'complex',
  tier: 'sonnet',
  cost: 3,
};

describe('outcomeFromObjective', () => {
  it('succeeds when no signals are specified', () => {
    expect(outcomeFromObjective(base, {}).success).toBe(true);
  });

  it('fails on crash', () => {
    expect(outcomeFromObjective(base, { crashed: true }).success).toBe(false);
  });

  it('fails on escalation', () => {
    expect(outcomeFromObjective(base, { escalationNeeded: true }).success).toBe(false);
  });

  it('fails on non-zero exit code', () => {
    expect(outcomeFromObjective(base, { exitCode: 1 }).success).toBe(false);
    expect(outcomeFromObjective(base, { exitCode: -1 }).success).toBe(false);
  });

  it('succeeds on exit code 0', () => {
    expect(outcomeFromObjective(base, { exitCode: 0 }).success).toBe(true);
  });

  it('fails when tests fail', () => {
    expect(outcomeFromObjective(base, { testsPass: false }).success).toBe(false);
  });

  it('fails when build fails', () => {
    expect(outcomeFromObjective(base, { buildPass: false }).success).toBe(false);
  });

  it('fails when over budget', () => {
    expect(outcomeFromObjective(base, { completedWithinBudget: false }).success).toBe(false);
  });

  it('succeeds when all signals pass', () => {
    expect(
      outcomeFromObjective(base, {
        exitCode: 0,
        testsPass: true,
        buildPass: true,
        crashed: false,
        completedWithinBudget: true,
        escalationNeeded: false,
      }).success,
    ).toBe(true);
  });

  it('sets source to objective', () => {
    expect(outcomeFromObjective(base, {}).source).toBe('objective');
  });
});

describe('outcomeFromReviewer (blocking-only adapter)', () => {
  it('critical verdict → failure', () => {
    expect(outcomeFromReviewer(base, 'critical').success).toBe(false);
  });

  it('concerns verdict → success (not blocking)', () => {
    expect(outcomeFromReviewer(base, 'concerns').success).toBe(true);
  });

  it('lgtm verdict → success', () => {
    expect(outcomeFromReviewer(base, 'lgtm').success).toBe(true);
  });

  it('sets source to reviewer', () => {
    expect(outcomeFromReviewer(base, 'lgtm').source).toBe('reviewer');
  });
});

describe('costShape', () => {
  it('failures always return weight 1 regardless of tier', () => {
    expect(costShape('haiku', false)).toBe(1);
    expect(costShape('sonnet', false)).toBe(1);
    expect(costShape('opus', false)).toBe(1);
  });

  it('success weight is inverse of tier cost', () => {
    expect(costShape('haiku', true)).toBe(1 / TIER_COST.haiku);
    expect(costShape('sonnet', true)).toBe(1 / TIER_COST.sonnet);
    expect(costShape('opus', true)).toBe(1 / TIER_COST.opus);
  });

  it('cheaper tier success outweighs expensive tier success', () => {
    const haikuWeight = costShape('haiku', true);
    const sonnetWeight = costShape('sonnet', true);
    const opusWeight = costShape('opus', true);
    expect(haikuWeight).toBeGreaterThan(sonnetWeight);
    expect(sonnetWeight).toBeGreaterThan(opusWeight);
  });
});
