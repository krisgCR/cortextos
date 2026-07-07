/**
 * tests/unit/daemon/ipc-cancel-run.test.ts — Task 3.3 (human cancel path)
 *
 * Unit tests for the `handleCancelRun` IPC handler exported from
 * src/daemon/ipc-server.ts. Exercises the handler directly (no live socket),
 * matching the pattern used by handleFireCron / handleAddCron.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleCancelRun } from '../../../src/daemon/ipc-server.js';
import type { CancelReason } from '../../../src/types/index.js';

describe('handleCancelRun', () => {
  it('rejects a missing run_id without calling cancelRunFn', () => {
    const cancelRunFn = vi.fn(async () => {});

    const response = handleCancelRun(undefined, cancelRunFn);

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/run_id/);
    expect(cancelRunFn).not.toHaveBeenCalled();
  });

  it('rejects a blank/whitespace run_id without calling cancelRunFn', () => {
    const cancelRunFn = vi.fn(async () => {});

    const response = handleCancelRun('   ', cancelRunFn);

    expect(response.success).toBe(false);
    expect(cancelRunFn).not.toHaveBeenCalled();
  });

  it('delegates to cancelRunFn with reason=human and returns success immediately (fire-and-forget)', async () => {
    let resolveCall!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveCall = resolve;
    });
    const cancelRunFn = vi.fn((_id: string, _reason: CancelReason) => pending);

    const response = handleCancelRun('run-abc123', cancelRunFn);

    // Handler returns synchronously — does NOT await the underlying cancelRun.
    expect(response.success).toBe(true);
    expect(response.data).toBe('Cancelling run run-abc123');
    expect(cancelRunFn).toHaveBeenCalledWith('run-abc123', 'human');
    expect(cancelRunFn).toHaveBeenCalledTimes(1);

    resolveCall();
    await pending;
  });

  it('never widens the cancel reason beyond human (this is the sole human-invoked kill path)', () => {
    const cancelRunFn = vi.fn(async () => {});

    handleCancelRun('run-xyz', cancelRunFn);

    const [, reasonArg] = cancelRunFn.mock.calls[0] as [string, CancelReason];
    expect(reasonArg).toBe('human');
  });

  it('swallows a rejected cancelRunFn without throwing out of the handler (best-effort, logged)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cancelRunFn = vi.fn(async () => {
      throw new Error('adapter terminate failed');
    });

    expect(() => handleCancelRun('run-err', cancelRunFn)).not.toThrow();

    // Let the rejected promise's .catch() handler run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
