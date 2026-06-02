import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuntimeCircuitBreaker } from '../../../src/routing/circuit-breaker';

const THRESHOLD = 3;
const TIMEOUT = 10_000; // 10s

let breaker: RuntimeCircuitBreaker;

beforeEach(() => {
  vi.useFakeTimers();
  breaker = new RuntimeCircuitBreaker({ failureThreshold: THRESHOLD, resetTimeout: TIMEOUT });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RuntimeCircuitBreaker', () => {
  describe('CLOSED state (default)', () => {
    it('starts closed — isOpen returns false', () => {
      expect(breaker.isOpen('codex')).toBe(false);
    });

    it('stays closed after fewer failures than threshold', () => {
      for (let i = 0; i < THRESHOLD - 1; i++) breaker.recordFailure('codex');
      expect(breaker.isOpen('codex')).toBe(false);
    });

    it('opens after reaching failureThreshold', () => {
      for (let i = 0; i < THRESHOLD; i++) breaker.recordFailure('codex');
      expect(breaker.isOpen('codex')).toBe(true);
    });

    it('resets failure count on success', () => {
      breaker.recordFailure('codex');
      breaker.recordFailure('codex');
      breaker.recordSuccess('codex');
      // Failure count should be reset — needs THRESHOLD more failures to open
      for (let i = 0; i < THRESHOLD - 1; i++) breaker.recordFailure('codex');
      expect(breaker.isOpen('codex')).toBe(false);
    });
  });

  describe('OPEN state → reroutes to Claude', () => {
    beforeEach(() => {
      for (let i = 0; i < THRESHOLD; i++) breaker.recordFailure('codex');
    });

    it('isOpen returns true while open', () => {
      expect(breaker.isOpen('codex')).toBe(true);
    });

    it('getStatus returns open', () => {
      expect(breaker.getStatus('codex')).toBe('open');
    });

    it('successes during OPEN state are ignored', () => {
      breaker.recordSuccess('codex');
      expect(breaker.isOpen('codex')).toBe(true);
    });

    it('transitions to half-open after resetTimeout', () => {
      vi.advanceTimersByTime(TIMEOUT);
      expect(breaker.isOpen('codex')).toBe(false); // half-open probe allowed
      expect(breaker.getStatus('codex')).toBe('half-open');
    });

    it('does not transition before resetTimeout', () => {
      vi.advanceTimersByTime(TIMEOUT - 1);
      expect(breaker.isOpen('codex')).toBe(true);
    });
  });

  describe('HALF-OPEN state (probe)', () => {
    beforeEach(() => {
      for (let i = 0; i < THRESHOLD; i++) breaker.recordFailure('codex');
      vi.advanceTimersByTime(TIMEOUT); // transitions to half-open
      breaker.isOpen('codex'); // trigger the transition
    });

    it('isOpen returns false (probe allowed)', () => {
      expect(breaker.isOpen('codex')).toBe(false);
    });

    it('probe success → closes the circuit', () => {
      breaker.recordSuccess('codex');
      expect(breaker.getStatus('codex')).toBe('closed');
      expect(breaker.isOpen('codex')).toBe(false);
    });

    it('probe failure → re-opens the circuit', () => {
      breaker.recordFailure('codex');
      expect(breaker.isOpen('codex')).toBe(true);
      expect(breaker.getStatus('codex')).toBe('open');
    });
  });

  describe('per-runtime isolation', () => {
    it('codex and claude track independently', () => {
      for (let i = 0; i < THRESHOLD; i++) breaker.recordFailure('codex');
      expect(breaker.isOpen('codex')).toBe(true);
      expect(breaker.isOpen('claude')).toBe(false); // unaffected
    });

    it('flag-OFF semantics: breaker state is maintained but caller decides whether to reroute', () => {
      // The breaker just reports; it's the caller's responsibility to reroute only when flag is ON.
      for (let i = 0; i < THRESHOLD; i++) breaker.recordFailure('codex');
      // isOpen() is still observable regardless of flag; flag-OFF means caller ignores it.
      expect(breaker.isOpen('codex')).toBe(true);
    });
  });
});
