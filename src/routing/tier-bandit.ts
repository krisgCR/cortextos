import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { BUCKET_SCHEME_VERSION } from './complexity.js';
import { TIER_COST, costShape } from './outcome.js';
import type { ComplexityBucket, Role, Tier } from './types.js';
import type { RoutingOutcome } from './outcome.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Min outcomes per (role×bucket) before Thompson sampling replaces the floor. */
const WARMUP_N = 5;

/** Write a new folded snapshot after this many cumulative new outcomes. */
const SNAPSHOT_EVERY = 100;

const STATE_VERSION = 1;
const SCHEMA_VERSION = 1;

const TIER_ORDER: Tier[] = ['haiku', 'sonnet', 'opus'];

// ── Internal types ─────────────────────────────────────────────────────────

type BucketKey = `${Role}:${ComplexityBucket}`;

interface Posterior {
  alpha: number;
  beta: number;
}

interface BucketEntry {
  posteriors: Record<Tier, Posterior>;
  outcomeCount: number;
}

export interface BanditStateSnapshot {
  version: number;
  schemaVersion: number;
  encoderVersion: number;
  checksum: string;
  updatedAt: string;
  /** Number of log lines folded into this snapshot. Replay starts at this offset. */
  logLinesSnapshot: number;
  buckets: Record<string, BucketEntry>;
}

export interface Bandit {
  selectTier(role: Role, bucket: ComplexityBucket): Tier;
  recordOutcome(outcome: RoutingOutcome, stateDir?: string): void;
  loadState(stateDir: string): void;
  getSnapshot(): BanditStateSnapshot;
}

// ── Beta sampling via Marsaglia-Tsang Gamma variates ──────────────────────

function sampleNormal(): number {
  // Box-Muller transform
  const u = Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleGamma(shape: number): number {
  if (shape < 1) {
    // Reduction: Gamma(shape) = Gamma(shape+1) * U^(1/shape)
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(Math.max(alpha, 1e-10));
  const y = sampleGamma(Math.max(beta, 1e-10));
  const sum = x + y;
  return sum === 0 ? 0.5 : x / sum;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function bucketKey(role: Role, bucket: ComplexityBucket): BucketKey {
  return `${role}:${bucket}`;
}

function tiersAtOrAbove(floor: Tier): Tier[] {
  const idx = TIER_ORDER.indexOf(floor);
  return idx < 0 ? TIER_ORDER : TIER_ORDER.slice(idx);
}

function emptyPosteriors(): Record<Tier, Posterior> {
  return { haiku: { alpha: 1, beta: 1 }, sonnet: { alpha: 1, beta: 1 }, opus: { alpha: 1, beta: 1 } };
}

function emptyEntry(): BucketEntry {
  return { posteriors: emptyPosteriors(), outcomeCount: 0 };
}

function checksumOf(buckets: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(buckets)).digest('hex');
}

function snapshotPath(stateDir: string): string {
  return join(stateDir, 'state.json');
}

function logPath(stateDir: string): string {
  return join(stateDir, 'outcomes.ndjson');
}

// ── Factory ────────────────────────────────────────────────────────────────

/** Default D18 tier floor per role. Passed in to avoid circular dep with index.ts. */
export const DEFAULT_FLOOR_MAP: Record<Role, Tier> = {
  explore: 'haiku',
  research: 'haiku',
  implement: 'sonnet',
  plan: 'opus',
  orchestrate: 'opus',
  review: 'opus',
};

export interface BanditOptions {
  floorMap?: Record<Role, Tier>;
}

export function createBandit(options: BanditOptions = {}): Bandit {
  const floorMap: Record<Role, Tier> = options.floorMap ?? DEFAULT_FLOOR_MAP;
  let buckets: Record<string, BucketEntry> = {};
  let outcomesSinceSnapshot = 0;
  let lastSnapshotAt: string | null = null;
  let totalLogLines = 0;

  function getOrCreate(role: Role, bucket: ComplexityBucket): BucketEntry {
    const key = bucketKey(role, bucket);
    if (!buckets[key]) buckets[key] = emptyEntry();
    return buckets[key]!;
  }

  function floorFor(role: Role): Tier {
    return floorMap[role] ?? 'sonnet';
  }

  function selectTier(role: Role, bucket: ComplexityBucket): Tier {
    const floor = floorFor(role);
    const entry = getOrCreate(role, bucket);

    // Warm-up gate: return floor deterministically until enough outcomes.
    if (entry.outcomeCount < WARMUP_N) return floor;

    // Thompson sampling over tiers ≥ floor, cost-weighted.
    const tiers = tiersAtOrAbove(floor);
    let bestTier = floor;
    let bestScore = -Infinity;

    for (const tier of tiers) {
      const p = entry.posteriors[tier] ?? { alpha: 1, beta: 1 };
      const sample = sampleBeta(p.alpha, p.beta);
      // Cost-weight: divide by cost so cheaper-but-adequate tiers score higher.
      const score = sample / (TIER_COST[tier] ?? 3);
      if (score > bestScore) {
        bestScore = score;
        bestTier = tier;
      }
    }

    // Floor clamp — the bandit NEVER returns a tier below the role's floor.
    const floorIdx = TIER_ORDER.indexOf(floor);
    const chosenIdx = TIER_ORDER.indexOf(bestTier);
    return chosenIdx >= floorIdx ? bestTier : floor;
  }

  function applyOutcomeToMemory(outcome: RoutingOutcome): void {
    const entry = getOrCreate(outcome.role, outcome.bucket);
    const p = entry.posteriors[outcome.tier] ?? { alpha: 1, beta: 1 };
    const weight = costShape(outcome.tier, outcome.success);
    if (outcome.success) {
      p.alpha += weight;
    } else {
      p.beta += weight;
    }
    entry.posteriors[outcome.tier] = p;
    entry.outcomeCount += 1;
  }

  function writeSnapshot(stateDir: string): void {
    const snap: BanditStateSnapshot = {
      version: STATE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      encoderVersion: BUCKET_SCHEME_VERSION,
      checksum: checksumOf(buckets),
      updatedAt: new Date().toISOString(),
      logLinesSnapshot: totalLogLines,
      buckets: structuredClone(buckets),
    };
    atomicWriteSync(snapshotPath(stateDir), JSON.stringify(snap));
    lastSnapshotAt = snap.updatedAt;
    outcomesSinceSnapshot = 0;
  }

  function recordOutcome(outcome: RoutingOutcome, stateDir?: string): void {
    // Append to outcomes log first (durable, concurrent-safe O_APPEND).
    if (stateDir) {
      ensureDir(stateDir);
      appendFileSync(logPath(stateDir), JSON.stringify(outcome) + '\n', 'utf-8');
      totalLogLines += 1;
    }

    applyOutcomeToMemory(outcome);
    outcomesSinceSnapshot += 1;

    if (stateDir && outcomesSinceSnapshot >= SNAPSHOT_EVERY) {
      writeSnapshot(stateDir);
    }
  }

  function loadState(stateDir: string): void {
    ensureDir(stateDir);
    const snap = snapshotPath(stateDir);
    const log = logPath(stateDir);

    let skipLines = 0;

    if (existsSync(snap)) {
      try {
        const raw = JSON.parse(readFileSync(snap, 'utf-8')) as BanditStateSnapshot;

        // Version/encoding compatibility checks → reset on incompatible, not crash.
        const compatible =
          raw.schemaVersion === SCHEMA_VERSION &&
          raw.encoderVersion === BUCKET_SCHEME_VERSION &&
          raw.checksum === checksumOf(raw.buckets as Record<BucketKey, BucketEntry>);

        if (compatible) {
          buckets = raw.buckets as Record<string, BucketEntry>;
          lastSnapshotAt = raw.updatedAt;
          skipLines = raw.logLinesSnapshot ?? 0;
        } else {
          // Incompatible: reset posteriors, replay full log.
          buckets = {};
          lastSnapshotAt = null;
          skipLines = 0;
        }
      } catch {
        buckets = {};
        lastSnapshotAt = null;
        skipLines = 0;
      }
    }

    // Replay outcomes not yet folded into snapshot.
    if (existsSync(log)) {
      const lines = readFileSync(log, 'utf-8').split('\n');
      let linesReplayed = 0;
      for (let i = skipLines; i < lines.length; i++) {
        const trimmed = lines[i]?.trim();
        if (!trimmed) continue;
        try {
          const outcome = JSON.parse(trimmed) as RoutingOutcome;
          applyOutcomeToMemory(outcome);
          linesReplayed += 1;
        } catch {
          // Corrupt line — skip.
        }
      }
      totalLogLines = lines.filter(l => l.trim()).length;
      outcomesSinceSnapshot = linesReplayed;
    } else {
      totalLogLines = skipLines;
      outcomesSinceSnapshot = 0;
    }
  }

  function getSnapshot(): BanditStateSnapshot {
    return {
      version: STATE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      encoderVersion: BUCKET_SCHEME_VERSION,
      checksum: checksumOf(buckets),
      updatedAt: lastSnapshotAt ?? new Date().toISOString(),
      logLinesSnapshot: totalLogLines,
      buckets: structuredClone(buckets),
    };
  }

  return { selectTier, recordOutcome, loadState, getSnapshot };
}
