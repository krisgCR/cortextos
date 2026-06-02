import { describe, it, expect } from 'vitest';
import { bucketOf, BUCKET_SCHEME_VERSION } from '../../../src/routing/complexity';

describe('bucketOf', () => {
  it('returns hint immediately when provided', () => {
    expect(bucketOf('list all files', 'complex')).toBe('complex');
    expect(bucketOf('implement a full auth system', 'trivial')).toBe('trivial');
    expect(bucketOf('', 'moderate')).toBe('moderate');
  });

  it('classifies complex keywords correctly', () => {
    expect(bucketOf('implement the new feature')).toBe('complex');
    expect(bucketOf('refactor the auth module')).toBe('complex');
    expect(bucketOf('debug the memory leak')).toBe('complex');
    expect(bucketOf('deploy to production')).toBe('complex');
    expect(bucketOf('research the best approach')).toBe('complex');
    expect(bucketOf('analyze the performance bottleneck')).toBe('complex');
  });

  it('classifies trivial keywords correctly', () => {
    expect(bucketOf('list all agents')).toBe('trivial');
    expect(bucketOf('get the current status')).toBe('trivial');
    expect(bucketOf('show me the logs')).toBe('trivial');
    expect(bucketOf('check if service is running')).toBe('trivial');
  });

  it('returns moderate for unrecognized text', () => {
    expect(bucketOf('do the thing')).toBe('moderate');
    expect(bucketOf('')).toBe('moderate');
    expect(bucketOf('a b c')).toBe('moderate');
  });

  it('complex takes precedence over trivial when both match', () => {
    // e.g. "implement and list" — complex wins because COMPLEX_RE tested first
    expect(bucketOf('implement and list all features')).toBe('complex');
  });

  it('only inspects first 500 chars', () => {
    const padding = 'x'.repeat(500);
    // complex keyword buried after 500 chars — should not trigger
    const longText = padding + ' implement this';
    expect(bucketOf(longText)).toBe('moderate');
    // trivial keyword in the first 500 chars
    const trivialFirst = 'list things ' + padding;
    expect(bucketOf(trivialFirst)).toBe('trivial');
  });

  it('BUCKET_SCHEME_VERSION is a positive integer', () => {
    expect(typeof BUCKET_SCHEME_VERSION).toBe('number');
    expect(BUCKET_SCHEME_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(BUCKET_SCHEME_VERSION)).toBe(true);
  });
});
