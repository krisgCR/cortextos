export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeout?: number; // ms
}

type CircuitStatus = 'closed' | 'open' | 'half-open';

interface CircuitState {
  status: CircuitStatus;
  failures: number;
  openedAt: number | null;
}

/**
 * Per-runtime circuit-breaker.
 * - CLOSED: operating normally, all dispatch passes through.
 * - OPEN: tripped after failureThreshold failures; isOpen() returns true,
 *         caller reroutes future dispatch to Claude.
 * - HALF-OPEN: after resetTimeout ms, one probe is allowed through.
 *              If it succeeds → CLOSED. If it fails → OPEN again.
 *
 * Does NOT feed the bandit posterior (breaker tracks runtime health, not task quality).
 * Does NOT terminate running agents — only affects FUTURE dispatch.
 */
export class RuntimeCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly states = new Map<string, CircuitState>();

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeout = opts.resetTimeout ?? 60_000;
  }

  private getOrCreate(runtime: string): CircuitState {
    if (!this.states.has(runtime)) {
      this.states.set(runtime, { status: 'closed', failures: 0, openedAt: null });
    }
    return this.states.get(runtime)!;
  }

  /**
   * Returns true when the circuit is OPEN for this runtime (block dispatch).
   * Transitions OPEN → HALF-OPEN automatically after resetTimeout.
   */
  isOpen(runtime: string): boolean {
    const s = this.getOrCreate(runtime);
    if (s.status === 'closed') return false;
    if (s.status === 'half-open') return false;
    // status === 'open'
    if (s.openedAt !== null && Date.now() - s.openedAt >= this.resetTimeout) {
      s.status = 'half-open';
      return false; // allow probe
    }
    return true;
  }

  /**
   * Record a failure for a runtime.
   * Increments failure count; opens the breaker after failureThreshold failures.
   * If already half-open, re-opens immediately.
   */
  recordFailure(runtime: string): void {
    const s = this.getOrCreate(runtime);
    s.failures += 1;
    if (s.status === 'half-open' || s.failures >= this.failureThreshold) {
      s.status = 'open';
      s.openedAt = Date.now();
    }
  }

  /**
   * Record a success for a runtime.
   * If in half-open state, closes the breaker (resets failures).
   * Successes during CLOSED state reset the failure counter.
   */
  recordSuccess(runtime: string): void {
    const s = this.getOrCreate(runtime);
    if (s.status === 'half-open' || s.status === 'closed') {
      s.status = 'closed';
      s.failures = 0;
      s.openedAt = null;
    }
    // In OPEN state, successes are ignored until the probe phase.
  }

  /** Return current status for observability (does not change state). */
  getStatus(runtime: string): CircuitStatus {
    return this.getOrCreate(runtime).status;
  }
}
