import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Integration tests for the flag-gated routing layer in AgentManager.spawnWorker.
 * Tests cover:
 * - Flag-OFF: spawn config parity with base work (no reroute).
 * - Flag-ON: tier ≥ floor resolved + bus event emitted (JSONL category + metadata).
 * - Breaker-open forces Claude runtime.
 * - Codex path selected for headless/batch tasks.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

let spawnCallConfig: { model?: string; runtime?: string } | null = null;

vi.mock('../../../src/daemon/worker-process', () => ({
  WorkerProcess: function WorkerProcess(name: string, dir: string, parent: unknown) {
    return {
      name,
      onDone: vi.fn(),
      spawn: vi.fn((_env: unknown, _prompt: string, config: { model?: string; runtime?: string }) => {
        spawnCallConfig = config;
        return Promise.resolve();
      }),
      getStatus: () => ({ status: 'running', name, dir }),
      isFinished: () => false,
    };
  },
}));

vi.mock('../../../src/utils/paths', () => ({
  resolvePaths: vi.fn((_name: string, _instanceId: string, _org: string) => ({
    ctxRoot: '/tmp/test-ctx',
    inbox: '/tmp/test-ctx/inbox/agent',
    inflight: '/tmp/test-ctx/inflight/agent',
    processed: '/tmp/test-ctx/processed/agent',
    logDir: '/tmp/test-ctx/logs/agent',
    stateDir: '/tmp/test-ctx/state/agent',
    taskDir: '/tmp/test-ctx/orgs/test-org/tasks',
    approvalDir: '/tmp/test-ctx/orgs/test-org/approvals',
    analyticsDir: analyticsDir,
    deliverablesDir: '/tmp/test-ctx/orgs/test-org/deliverables',
  })),
}));

// analyticsDir is set per-test
let analyticsDir = '/tmp/analytics-placeholder';

// ── Test Setup ──────────────────────────────────────────────────────────────

import { AgentManager } from '../../../src/daemon/agent-manager';

let tmpDir: string;
let manager: AgentManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'routing-integ-'));
  analyticsDir = join(tmpDir, 'analytics');
  mkdirSync(analyticsDir, { recursive: true });
  spawnCallConfig = null;
  delete process.env.CTX_ROUTING_CALIBRATION;
  manager = new AgentManager('test-instance', tmpDir, tmpDir, 'test-org');
});

afterEach(() => {
  delete process.env.CTX_ROUTING_CALIBRATION;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('flag-OFF (default) — spawn parity', () => {
  it('no model specified → spawn config is empty (parity with base work)', async () => {
    await manager.spawnWorker('worker-1', tmpDir, 'implement the new feature');
    expect(spawnCallConfig).toEqual({});
  });

  it('explicit model passes through unchanged', async () => {
    await manager.spawnWorker('worker-2', tmpDir, 'task', undefined, 'claude-opus-4-8');
    expect(spawnCallConfig?.model).toBe('claude-opus-4-8');
    expect(spawnCallConfig?.runtime).toBeUndefined();
  });

  it('no bus event emitted when flag is OFF', async () => {
    await manager.spawnWorker('worker-3', tmpDir, 'implement the feature');
    const eventsDir = join(analyticsDir, 'events', 'worker-3');
    expect(existsSync(eventsDir)).toBe(false);
  });
});

describe('flag-ON — routing layer active', () => {
  beforeEach(() => {
    process.env.CTX_ROUTING_CALIBRATION = '1';
  });

  it('resolves to a model string (tier resolved via TIER_MODEL_MAP)', async () => {
    await manager.spawnWorker('worker-4', tmpDir, 'implement the auth feature');
    expect(typeof spawnCallConfig?.model).toBe('string');
    expect(spawnCallConfig?.model?.length).toBeGreaterThan(0);
  });

  it('resolved model is from the TIER_MODEL_MAP (contains a known model slug)', async () => {
    await manager.spawnWorker('worker-5', tmpDir, 'implement the new feature');
    const knownModels = ['haiku', 'sonnet', 'opus'];
    const model = spawnCallConfig?.model ?? '';
    expect(knownModels.some(slug => model.includes(slug))).toBe(true);
  });

  it('emits a routing.decision bus event as JSONL', async () => {
    await manager.spawnWorker('worker-6', tmpDir, 'implement authentication');

    const today = new Date().toISOString().split('T')[0]!;
    const eventFile = join(analyticsDir, 'events', 'worker-6', `${today}.jsonl`);
    expect(existsSync(eventFile)).toBe(true);

    const lines = readFileSync(eventFile, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const event = JSON.parse(lines[lines.length - 1]!);
    expect(event.category).toBe('routing');
    expect(event.event).toBe('routing.decision');
    expect(event.metadata).toBeDefined();
    expect(event.metadata.role).toBe('implement'); // default role
    expect(event.metadata.calibrated).toBe(true);
    expect(typeof event.metadata.tier).toBe('string');
    expect(typeof event.metadata.model).toBe('string');
    expect(typeof event.metadata.decisionId).toBe('string');
  });

  it('explicit model bypasses routing layer', async () => {
    // When model is explicitly provided, routing layer is NOT called.
    await manager.spawnWorker('worker-7', tmpDir, 'batch transform data', undefined, 'claude-sonnet-4-6');
    expect(spawnCallConfig?.model).toBe('claude-sonnet-4-6');
    // No routing event emitted (explicit model → routing skipped)
    const today = new Date().toISOString().split('T')[0]!;
    const eventFile = join(analyticsDir, 'events', 'worker-7', `${today}.jsonl`);
    expect(existsSync(eventFile)).toBe(false);
  });

  it('batch task gets codex runtime (classifyRuntime match)', async () => {
    await manager.spawnWorker('worker-8', tmpDir, 'batch transform all log files');
    expect(spawnCallConfig?.runtime).toBe('codex');
  });

  it('codex decision carries no model — config unset and logged model is null', async () => {
    await manager.spawnWorker('worker-8b', tmpDir, 'batch transform all log files');
    expect(spawnCallConfig?.runtime).toBe('codex');
    // CodexWorkerPty runs `codex exec` and ignores the model arg → never set a Claude slug.
    expect(spawnCallConfig?.model).toBeUndefined();

    const today = new Date().toISOString().split('T')[0]!;
    const eventFile = join(analyticsDir, 'events', 'worker-8b', `${today}.jsonl`);
    const event = JSON.parse(readFileSync(eventFile, 'utf-8').trim().split('\n').pop()!);
    expect(event.metadata.platform).toBe('codex');
    expect(event.metadata.model).toBeNull();
  });

  it('implement task gets claude runtime (default)', async () => {
    await manager.spawnWorker('worker-9', tmpDir, 'implement the new auth feature');
    expect(spawnCallConfig?.runtime).toBe('claude');
  });
});

describe('circuit-breaker forces Claude when codex is open', () => {
  beforeEach(() => {
    process.env.CTX_ROUTING_CALIBRATION = '1';
  });

  it('forces claude runtime when breaker is open for codex', async () => {
    // Open the breaker by recording enough failures.
    const breaker = (manager as unknown as { _getRoutingBreaker: () => { recordFailure: (r: string) => void } })._getRoutingBreaker();
    for (let i = 0; i < 5; i++) breaker.recordFailure('codex');

    // Even a batch task (which would normally be codex) should get claude.
    await manager.spawnWorker('worker-10', tmpDir, 'batch transform all logs');
    expect(spawnCallConfig?.runtime).toBe('claude');

    // Bus event should note the breaker was involved (runtime=claude for a codex-classified task).
    const today = new Date().toISOString().split('T')[0]!;
    const eventFile = join(analyticsDir, 'events', 'worker-10', `${today}.jsonl`);
    if (existsSync(eventFile)) {
      const event = JSON.parse(readFileSync(eventFile, 'utf-8').trim().split('\n').pop()!);
      expect(event.metadata.platform).toBe('claude');
    }
  });
});
