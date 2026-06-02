import type { ComplexityBucket } from './types.js';

export type { ComplexityBucket };

/**
 * Version of the bucket encoding scheme.
 * Bump when keyword rules change to invalidate stale bandit posteriors.
 */
export const BUCKET_SCHEME_VERSION = 1;

// Matches unambiguously simple read/status operations.
const TRIVIAL_RE =
  /\b(list|show|get|fetch|check|status|print|echo|display|count|read|view|open|describe|ping|verify|confirm|report|summarize)\b/i;

// Matches substantive work: construction, transformation, debugging, research.
// Leading \b prevents mid-word matches; no trailing \b so stems match conjugated forms
// (e.g. "analyz" → analyze/analyzes/analyzing, "migrat" → migrate/migration).
const COMPLEX_RE =
  /\b(migrat|refactor|architect|redesign|rewrite|integrat|audit|optimiz|benchmark|orchestrat|implement|design|build|creat|develop|analyz|debug|fix|resolv|troubleshoot|investigat|research|deploy|scale|secur|auth|encrypt|generat|transform|process|extract|aggregat)/i;

/**
 * Classify a task description into a complexity bucket.
 * Deterministic: explicit hint wins; keyword scorer is the fallback.
 * Only the first 500 characters of text are inspected for performance.
 */
export function bucketOf(text: string, hint?: ComplexityBucket): ComplexityBucket {
  if (hint !== undefined) return hint;
  const sample = text.slice(0, 500);
  if (COMPLEX_RE.test(sample)) return 'complex';
  if (TRIVIAL_RE.test(sample)) return 'trivial';
  return 'moderate';
}
