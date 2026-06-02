import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';

/**
 * Worker runtime-select tests.
 * Verifies WorkerProcess picks the right PTY based on the `runtime` config field.
 * Both AgentPTY and CodexWorkerPty are mocked — no real spawns.
 */

// ── Mock state (captured by constructors below) ────────────────────────────

let agentPtyCallCount = 0;
let codexPtyCallCount = 0;
let lastAgentPtyArgs: unknown[] = [];
let lastCodexPtyArgs: unknown[] = [];
let capturedOnExit: ((code: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  onExit: vi.fn().mockImplementation((cb: (code: number) => void) => {
    capturedOnExit = cb;
  }),
};

// Named functions are constructable with `new`, unlike arrow functions.
vi.mock('../../../src/pty/agent-pty', () => ({
  AgentPTY: function AgentPTY(...args: unknown[]) {
    agentPtyCallCount += 1;
    lastAgentPtyArgs = args;
    return mockPty;
  },
}));

vi.mock('../../../src/pty/codex-worker-pty', () => ({
  CodexWorkerPty: function CodexWorkerPty(...args: unknown[]) {
    codexPtyCallCount += 1;
    lastCodexPtyArgs = args;
    return mockPty;
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, mkdirSync: vi.fn() };
});

import { WorkerProcess } from '../../../src/daemon/worker-process';

const makeEnv = (name = 'w') => ({
  instanceId: 'test-instance',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/test-fw',
  agentName: name,
  agentDir: `/tmp/${name}`,
  org: 'test-org',
  projectRoot: '/tmp/test-fw',
});

beforeEach(() => {
  agentPtyCallCount = 0;
  codexPtyCallCount = 0;
  lastAgentPtyArgs = [];
  lastCodexPtyArgs = [];
  capturedOnExit = null;
  vi.clearAllMocks();
  mockPty.spawn.mockResolvedValue(undefined);
  mockPty.getPid.mockReturnValue(12345);
  mockPty.onExit.mockImplementation((cb: (code: number) => void) => {
    capturedOnExit = cb;
  });
});

describe('WorkerProcess runtime-select', () => {
  it('uses AgentPTY when runtime is unspecified (Claude default unchanged)', async () => {
    const worker = new WorkerProcess('w1', '/tmp', undefined);
    await worker.spawn(makeEnv('w1'), 'do a task');

    expect(agentPtyCallCount).toBe(1);
    expect(codexPtyCallCount).toBe(0);
  });

  it('uses AgentPTY when runtime is explicitly claude-code', async () => {
    const worker = new WorkerProcess('w2', '/tmp', undefined);
    await worker.spawn(makeEnv('w2'), 'do a task', { runtime: 'claude-code' });

    expect(agentPtyCallCount).toBe(1);
    expect(codexPtyCallCount).toBe(0);
  });

  it('uses CodexWorkerPty when runtime is codex', async () => {
    const worker = new WorkerProcess('w3', '/tmp', undefined);
    await worker.spawn(makeEnv('w3'), 'batch process logs', { runtime: 'codex' });

    expect(codexPtyCallCount).toBe(1);
    expect(agentPtyCallCount).toBe(0);
  });

  it('passes prompt to codex worker spawn', async () => {
    const worker = new WorkerProcess('w4', '/tmp', undefined);
    const prompt = 'batch extract all data from CSV files';
    await worker.spawn(makeEnv('w4'), prompt, { runtime: 'codex' });

    expect(mockPty.spawn).toHaveBeenCalledWith('fresh', prompt);
  });

  it('passes model to AgentPTY constructor', async () => {
    const worker = new WorkerProcess('w5', '/tmp', undefined);
    await worker.spawn(makeEnv('w5'), 'do task', { model: 'claude-opus-4-8' });

    expect((lastAgentPtyArgs[1] as { model?: string })?.model).toBe('claude-opus-4-8');
  });

  it('CodexWorkerPty receives correct logPath and workDir', async () => {
    const env = makeEnv('w6');
    const worker = new WorkerProcess('w6', '/my/workdir', undefined);
    await worker.spawn(env, 'task', { runtime: 'codex' });

    expect(lastCodexPtyArgs[0]).toBe(join(env.ctxRoot, 'logs', 'w6', 'stdout.log'));
    expect(lastCodexPtyArgs[1]).toBe('/my/workdir');
  });

  it('status transitions to running after successful spawn', async () => {
    const worker = new WorkerProcess('w7', '/tmp', undefined);
    await worker.spawn(makeEnv('w7'), 'task');

    expect(worker.getStatus().status).toBe('running');
  });

  it('status transitions to failed on non-zero exit', async () => {
    const worker = new WorkerProcess('w8', '/tmp', undefined);
    await worker.spawn(makeEnv('w8'), 'task');

    capturedOnExit!(1);
    expect(worker.getStatus().status).toBe('failed');
    expect(worker.getStatus().exitCode).toBe(1);
  });

  it('status transitions to completed on exit code 0', async () => {
    const worker = new WorkerProcess('w9', '/tmp', undefined);
    await worker.spawn(makeEnv('w9'), 'task');

    capturedOnExit!(0);
    expect(worker.getStatus().status).toBe('completed');
  });
});
