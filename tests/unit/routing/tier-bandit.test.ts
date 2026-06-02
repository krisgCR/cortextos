import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { createBandit, DEFAULT_FLOOR_MAP } from '../../../src/routing/tier-bandit';
import { outcomeFromReviewer } from '../../../src/routing/outcome';
import { atomicWriteSync } from '../../../src/utils/atomic';
import type { RoutingOutcome } from '../../../src/routing/outcome';
import type { Role, Tier } from '../../../src/routing/types';

const ALL_ROLES: Role[] = ['explore', 'research', 'implement', 'plan', 'orchestrate', 'review'];
const ALL_BUCKETS = ['trivial', 'moderate', 'complex'] as const;
const TIER_ORDER: Tier[] = ['haiku', 'sonnet', 'opus'];

function makeOutcome(
  role: Role,
  tier: Tier,
  success: boolean,
  id = 'test',
): RoutingOutcome {
  return {
    decisionId: id,
    role,
    bucket: 'moderate',
    tier,
    success,
    cost: 3,
    source: 'objective',
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bandit-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('warm-up gate — cold-start ≡ static floor', () => {
  it('returns floor for every role×bucket when no outcomes recorded', () => {
    const bandit = createBandit();
    for (const role of ALL_ROLES) {
      for (const bucket of ALL_BUCKETS) {
        const tier = bandit.selectTier(role, bucket);
        const floor = DEFAULT_FLOOR_MAP[role]!;
        expect(tier).toBe(floor);
      }
    }
  });

  it('still returns floor with fewer than WARMUP_N outcomes', () => {
    const bandit = createBandit();
    // Record 4 outcomes (WARMUP_N = 5, so still in warm-up)
    for (let i = 0; i < 4; i++) {
      bandit.recordOutcome(makeOutcome('implement', 'sonnet', true, `id-${i}`));
    }
    expect(bandit.selectTier('implement', 'moderate')).toBe('sonnet');
  });
});

describe('floor invariant — never violated regardless of posteriors', () => {
  it('does not return a tier below floor even with extreme posteriors', () => {
    // Use haiku role that has floor=haiku — sonnet/opus should be selectable
    // Use implement role that has floor=sonnet — haiku should never appear
    const bandit = createBandit();

    // Force posteriors so haiku looks very attractive for 'implement'
    // by recording many successes with haiku (which is below the floor)
    // The bandit shouldn't route 'implement' to haiku regardless.
    for (let i = 0; i < 20; i++) {
      bandit.recordOutcome({
        decisionId: `id-${i}`,
        role: 'implement',
        bucket: 'moderate',
        tier: 'haiku', // below floor for implement
        success: true,
        cost: 1,
        source: 'objective',
      });
    }

    // Run 100 draws — none should be below sonnet (the floor for implement)
    const floorIdx = TIER_ORDER.indexOf('sonnet');
    for (let i = 0; i < 100; i++) {
      const tier = bandit.selectTier('implement', 'moderate');
      const tierIdx = TIER_ORDER.indexOf(tier);
      expect(tierIdx).toBeGreaterThanOrEqual(floorIdx);
    }
  });

  it('property: floor never violated for all roles after random outcomes', () => {
    const bandit = createBandit();

    // Seed with random outcomes across roles/tiers
    const tiers: Tier[] = ['haiku', 'sonnet', 'opus'];
    for (const role of ALL_ROLES) {
      for (let i = 0; i < 15; i++) {
        const tier = tiers[i % 3]!;
        bandit.recordOutcome({
          decisionId: `${role}-${i}`,
          role,
          bucket: ALL_BUCKETS[i % 3]!,
          tier,
          success: i % 2 === 0,
          cost: [1, 3, 9][i % 3]!,
          source: 'objective',
        });
      }
    }

    for (const role of ALL_ROLES) {
      for (const bucket of ALL_BUCKETS) {
        const floor = DEFAULT_FLOOR_MAP[role]!;
        const floorIdx = TIER_ORDER.indexOf(floor);
        for (let draw = 0; draw < 20; draw++) {
          const tier = bandit.selectTier(role, bucket);
          expect(TIER_ORDER.indexOf(tier)).toBeGreaterThanOrEqual(floorIdx);
        }
      }
    }
  });
});

describe('recordOutcome — posterior updates correct bucket', () => {
  it('updates posteriors for the correct role×bucket', () => {
    const bandit = createBandit();

    // Record 10 successes for implement/moderate/sonnet
    for (let i = 0; i < 10; i++) {
      bandit.recordOutcome({
        decisionId: `impl-${i}`,
        role: 'implement',
        bucket: 'moderate',
        tier: 'sonnet',
        success: true,
        cost: 3,
        source: 'objective',
      });
    }

    const snap = bandit.getSnapshot();
    const entry = snap.buckets['implement:moderate'];
    expect(entry).toBeDefined();
    expect(entry!.outcomeCount).toBe(10);
    // alpha should have grown from 1 (10 successes × costShape(sonnet, true) = 10/3)
    expect(entry!.posteriors.sonnet.alpha).toBeGreaterThan(1);

    // Unrelated bucket should be untouched
    const other = snap.buckets['explore:trivial'];
    expect(other).toBeUndefined(); // never accessed
  });

  it('reviewer blocking-only: critical failure updates beta; lgtm updates alpha', () => {
    const bandit = createBandit();

    const baseOutcome = {
      decisionId: 'r1',
      role: 'review' as Role,
      bucket: 'complex' as const,
      tier: 'opus' as Tier,
      cost: 9,
    };

    // Seed past warm-up
    for (let i = 0; i < 5; i++) {
      bandit.recordOutcome({ ...baseOutcome, decisionId: `seed-${i}`, success: i < 3, source: 'objective' as const });
    }

    const snapBefore = bandit.getSnapshot();
    const alphaBefore = snapBefore.buckets['review:complex']?.posteriors.opus.alpha ?? 1;
    const betaBefore = snapBefore.buckets['review:complex']?.posteriors.opus.beta ?? 1;

    // Critical → failure → beta increases
    bandit.recordOutcome(outcomeFromReviewer(baseOutcome, 'critical'));
    const snapAfterCritical = bandit.getSnapshot();
    expect(snapAfterCritical.buckets['review:complex']!.posteriors.opus.beta).toBeGreaterThan(betaBefore);

    const betaAfterCritical = snapAfterCritical.buckets['review:complex']!.posteriors.opus.beta;

    // lgtm → success → alpha increases
    bandit.recordOutcome(outcomeFromReviewer({ ...baseOutcome, decisionId: 'r2' }, 'lgtm'));
    const snapAfterLgtm = bandit.getSnapshot();
    expect(snapAfterLgtm.buckets['review:complex']!.posteriors.opus.alpha).toBeGreaterThan(alphaBefore);
  });
});

describe('append-only log + fold', () => {
  it('persists outcomes to log file', () => {
    const bandit = createBandit();
    bandit.recordOutcome(makeOutcome('implement', 'sonnet', true, 'id-1'), tmpDir);
    bandit.recordOutcome(makeOutcome('implement', 'sonnet', false, 'id-2'), tmpDir);

    const log = readFileSync(join(tmpDir, 'outcomes.ndjson'), 'utf-8').trim().split('\n');
    expect(log).toHaveLength(2);
    expect(JSON.parse(log[0]!).decisionId).toBe('id-1');
    expect(JSON.parse(log[1]!).decisionId).toBe('id-2');
  });

  it('loadState replays log and matches in-memory posteriors', () => {
    const bandit1 = createBandit();
    for (let i = 0; i < 8; i++) {
      bandit1.recordOutcome(makeOutcome('implement', 'sonnet', i < 6, `id-${i}`), tmpDir);
    }
    const snap1 = bandit1.getSnapshot();

    const bandit2 = createBandit();
    bandit2.loadState(tmpDir);
    const snap2 = bandit2.getSnapshot();

    expect(snap2.buckets['implement:moderate']?.outcomeCount).toBe(8);
    expect(snap2.buckets['implement:moderate']?.posteriors.sonnet.alpha).toBeCloseTo(
      snap1.buckets['implement:moderate']!.posteriors.sonnet.alpha,
      5,
    );
  });

  it('concurrency: two interleaved writers lose no increment', () => {
    // Simulate two bandit instances writing to the same log alternately.
    const banditA = createBandit();
    const banditB = createBandit();

    for (let i = 0; i < 5; i++) {
      banditA.recordOutcome(makeOutcome('implement', 'sonnet', true, `a-${i}`), tmpDir);
      banditB.recordOutcome(makeOutcome('implement', 'sonnet', false, `b-${i}`), tmpDir);
    }

    // Both wrote 5 outcomes each = 10 total lines
    const lines = readFileSync(join(tmpDir, 'outcomes.ndjson'), 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(10);

    // A fresh bandit loading the log should see all 10 outcomes
    const fresh = createBandit();
    fresh.loadState(tmpDir);
    expect(fresh.getSnapshot().buckets['implement:moderate']?.outcomeCount).toBe(10);
  });
});

describe('persistence round-trip', () => {
  it('snapshot round-trips with version/checksum', () => {
    const bandit = createBandit();
    for (let i = 0; i < 5; i++) {
      bandit.recordOutcome(makeOutcome('plan', 'opus', true, `id-${i}`), tmpDir);
    }

    // Force a snapshot write by triggering it manually
    const snap = bandit.getSnapshot();
    const snapData = {
      ...snap,
      checksum: createHash('sha256').update(JSON.stringify(snap.buckets)).digest('hex'),
    };
    atomicWriteSync(join(tmpDir, 'state.json'), JSON.stringify(snapData));

    const fresh = createBandit();
    fresh.loadState(tmpDir);

    const freshSnap = fresh.getSnapshot();
    expect(freshSnap.buckets['plan:moderate']?.outcomeCount).toBe(5);
  });

  it('corrupted snapshot → reset, not crash', () => {
    writeFileSync(join(tmpDir, 'state.json'), '{ not valid json }{{{', 'utf-8');

    const bandit = createBandit();
    expect(() => bandit.loadState(tmpDir)).not.toThrow();
    // Should start fresh — cold-start floor
    expect(bandit.selectTier('implement', 'moderate')).toBe('sonnet');
  });

  it('wrong schemaVersion → reset, not crash', () => {
    const snap = {
      version: 1,
      schemaVersion: 999, // incompatible
      encoderVersion: 1,
      checksum: 'bad',
      updatedAt: new Date().toISOString(),
      logLinesSnapshot: 0,
      buckets: {},
    };
    writeFileSync(join(tmpDir, 'state.json'), JSON.stringify(snap), 'utf-8');

    const bandit = createBandit();
    expect(() => bandit.loadState(tmpDir)).not.toThrow();
    expect(bandit.selectTier('implement', 'moderate')).toBe('sonnet');
  });

  it('mismatched encoderVersion → reset, not crash', () => {
    const snap = {
      version: 1,
      schemaVersion: 1,
      encoderVersion: 999, // wrong BUCKET_SCHEME_VERSION
      checksum: 'bad',
      updatedAt: new Date().toISOString(),
      logLinesSnapshot: 0,
      buckets: {},
    };
    writeFileSync(join(tmpDir, 'state.json'), JSON.stringify(snap), 'utf-8');

    const bandit = createBandit();
    expect(() => bandit.loadState(tmpDir)).not.toThrow();
    expect(bandit.selectTier('explore', 'trivial')).toBe('haiku');
  });

  it('bad checksum → reset, not crash', () => {
    const snap = {
      version: 1,
      schemaVersion: 1,
      encoderVersion: 1,
      checksum: 'deliberate-wrong-checksum',
      updatedAt: new Date().toISOString(),
      logLinesSnapshot: 0,
      buckets: { 'implement:moderate': { posteriors: { haiku: { alpha: 99, beta: 1 }, sonnet: { alpha: 1, beta: 99 }, opus: { alpha: 1, beta: 1 } }, outcomeCount: 100 } },
    };
    writeFileSync(join(tmpDir, 'state.json'), JSON.stringify(snap), 'utf-8');

    const bandit = createBandit();
    expect(() => bandit.loadState(tmpDir)).not.toThrow();
    // Posteriors from bad snapshot should NOT be loaded
    // (with no log, we'd be at cold-start for implement)
    expect(bandit.selectTier('implement', 'moderate')).toBe('sonnet');
  });
});
