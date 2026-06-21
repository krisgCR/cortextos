import { describe, it, expect } from 'vitest';
import type {
  RunSpec,
  RunStatus,
  RuntimeEvent,
  RuntimeCapabilities,
  CapabilityGrade,
  Runtime,
  BillingPool,
  RunLease,
  FencingToken,
  OwnershipEpoch,
  RuntimeEventKind,
} from '../../../src/types/index.js';

describe('D24 Runtime-Boundary Type Contract', () => {
  it('RunSpec survives a JSON round-trip', () => {
    const spec: RunSpec = {
      run_id: 'run-abc-123',
      parent_run_id: 'run-parent-456',
      runtime: 'claude-bg' satisfies Runtime,
      model: 'claude-opus-4-5',
      cwd: '/tmp/runs/run-abc-123',
      worktree: '/tmp/worktrees/run-abc-123',
      deadline: '2026-06-15T00:00:00.000Z',
      idempotency_key: 'idem-xyz-789',
      approval_boundaries: ['financial', 'data-deletion'],
      verification_contract: 'v1/strict',
      billing_pool: 'subscription' satisfies BillingPool,
      budget_tokens: 50000,
      budget_cost_usd: 0.5,
    };

    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
  });

  it('RunSpec with minimal required fields survives a JSON round-trip', () => {
    const minSpec: RunSpec = {
      run_id: 'run-min-001',
      runtime: 'codex-exec' satisfies Runtime,
      model: 'gpt-4o',
      cwd: '/tmp/runs/run-min-001',
      idempotency_key: 'idem-min-001',
      billing_pool: 'metered' satisfies BillingPool,
    };

    expect(JSON.parse(JSON.stringify(minSpec))).toEqual(minSpec);
  });

  it('RunStatus survives a JSON round-trip', () => {
    const lease: RunLease = {
      worktree: '/tmp/worktrees/run-abc-123',
      holderRunId: 'run-abc-123',
      fencingToken: 'fence-token-v2' satisfies FencingToken,
      epoch: 3 satisfies OwnershipEpoch,
      heartbeat: '2026-06-14T12:00:00.000Z',
    };

    const status: RunStatus = {
      run_id: 'run-abc-123',
      state: 'working',
      phase: 'executing',
      tokens: 1234,
      cost: 0.002,
      billing_pool: 'subscription' satisfies BillingPool,
      heartbeat: '2026-06-14T12:00:00.000Z',
      budget_remaining_tokens: 48766,
      budget_remaining_cost_usd: 0.498,
      lease,
      ownership_epoch: 3 satisfies OwnershipEpoch,
    };

    expect(JSON.parse(JSON.stringify(status))).toEqual(status);
  });

  it('RunStatus with minimal required fields survives a JSON round-trip', () => {
    const minStatus: RunStatus = {
      run_id: 'run-min-001',
      state: 'done',
      billing_pool: 'unknown' satisfies BillingPool,
      heartbeat: '2026-06-14T12:00:00.000Z',
    };

    expect(JSON.parse(JSON.stringify(minStatus))).toEqual(minStatus);
  });

  it('RuntimeEvent survives a JSON round-trip', () => {
    const event: RuntimeEvent = {
      kind: 'turn' satisfies RuntimeEventKind,
      run_id: 'run-abc-123',
      session_id: 'sess-native-uuid-xyz',
      timestamp: '2026-06-14T12:00:00.000Z',
      payload: {
        turn_index: 1,
        input_tokens: 500,
        output_tokens: 200,
        tool: 'bash',
      },
    };

    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it('all RuntimeEventKind values are valid string literals', () => {
    const kinds: RuntimeEventKind[] = ['turn', 'tool-call', 'artifact', 'lifecycle'];
    for (const kind of kinds) {
      const event: RuntimeEvent = {
        kind,
        run_id: 'run-test',
        session_id: 'sess-test',
        timestamp: '2026-06-14T12:00:00.000Z',
        payload: {},
      };
      expect(JSON.parse(JSON.stringify(event)).kind).toBe(kind);
    }
  });

  it('RuntimeCapabilities type-checks with all CapabilityGrade values', () => {
    const allGrades: CapabilityGrade[] = ['native', 'emulated', 'degraded', 'none', 'unknown'];

    const caps: RuntimeCapabilities = {
      observe: {
        process: 'native',
        turn: 'emulated',
        tool: 'degraded',
        descendants: 'none',
        cost: 'unknown',
      },
      control: {
        submitTurn: 'native',
        steerActiveTurn: 'none',
        interruptTurn: 'emulated',
        terminateRun: 'native',
        drain: 'degraded',
      },
      recovery: {
        resumeConversation: 'native',
        reattachLiveProcess: 'degraded',
        rewindFiles: 'none',
        adoptOrphan: 'unknown',
      },
      isolation: {
        root: 'worktree',
        descendants: 'shared',
      },
    };

    // Verify observe.process is one of the valid grades
    expect(allGrades).toContain(caps.observe.process);
    // Verify the full caps object round-trips (all grades are JSON-safe strings)
    expect(JSON.parse(JSON.stringify(caps))).toEqual(caps);
  });

  it('all Runtime values are valid string literals', () => {
    const runtimes: Runtime[] = [
      'claude-bg',
      'codex-app-server',
      'codex-exec',
      'hermes',
      'workflow-observer',
      'claude-discovery',
    ];
    for (const runtime of runtimes) {
      const spec: RunSpec = {
        run_id: `run-${runtime}`,
        runtime,
        model: 'test-model',
        cwd: '/tmp',
        idempotency_key: `idem-${runtime}`,
        billing_pool: 'unknown',
      };
      expect(JSON.parse(JSON.stringify(spec)).runtime).toBe(runtime);
    }
  });

  it('all BillingPool values survive JSON round-trip', () => {
    const pools: BillingPool[] = ['subscription', 'metered', 'unknown'];
    for (const pool of pools) {
      const status: RunStatus = {
        run_id: `run-pool-${pool}`,
        state: 'working',
        billing_pool: pool,
        heartbeat: '2026-06-14T12:00:00.000Z',
      };
      expect(JSON.parse(JSON.stringify(status)).billing_pool).toBe(pool);
    }
  });
});
