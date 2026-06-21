/**
 * tests/integration/runtime-observer.test.ts
 *
 * Integration tests for the runtime observer (runtime-observer.ts).
 *
 * Tests `observeOnce()` with fixture journals + a mocked run-authority ledger:
 *   - Boundary record is written to CTX_ROOT/state/runtimes/<run_id>.json
 *   - Degraded flag is correct for a run with a failed child in fixture journal
 *   - Only ledger-correlated sessions produce records (ledger-gating)
 *   - Graceful degradation when ledger is empty
 *
 * Strategy:
 *   - Set CTX_ROOT env to a temp dir so the observer writes there.
 *   - Mock run-authority.allRecords and spawnAgentsCli at top level using
 *     vi.mock with factory functions that read shared mutable state.
 *   - Provide fixture journals via a local temp dir.
 *
 * Note: vi.mock is hoisted by vitest, so we use a factory pattern where the
 * mock implementation reads from a shared `__mockState` object set in each test.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeBoundaryRecord } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Shared mock state — read by the hoisted vi.mock factories
// ---------------------------------------------------------------------------

const __mockState = {
  ledgerRuns: [] as Array<{
    run_id: string;
    idempotency_key: string;
    native_id?: string;
    worktree?: string;
    epoch: number;
    heartbeat: string;
    state: 'pending' | 'live' | 'done' | 'orphaned';
  }>,
  discoveryEntries: [] as Array<{ id: string; state: string; cwd?: string; sessionId?: string }>,
};

// Top-level vi.mock calls (hoisted by vitest).
vi.mock('../../src/runtime/run-authority.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/runtime/run-authority.js')>();
  return {
    ...original,
    allRecords: (_instanceId: string) => __mockState.ledgerRuns,
  };
});

vi.mock('../../src/runtime/adapters/claude-discovery.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/runtime/adapters/claude-discovery.js')>();
  return {
    ...original,
    spawnAgentsCli: async () => ({
      entries: __mockState.discoveryEntries,
      stdout: JSON.stringify(__mockState.discoveryEntries),
    }),
  };
});

// ---------------------------------------------------------------------------
// Fixture content for run-abc123 (contains a failed child → degraded)
// ---------------------------------------------------------------------------

const FIXTURE_JOURNAL = [
  '{"type":"agent.started","agentId":"root-agent","label":"main task agent"}',
  '{"type":"agent.started","agentId":"sub-agent-1","parentId":"root-agent","label":"research subtask"}',
  '{"type":"agent.started","agentId":"sub-agent-2","parentId":"root-agent","label":"implementation subtask"}',
  '{"type":"agent.stopped","agentId":"sub-agent-1","state":"done"}',
  '{"type":"agent.failed","agentId":"sub-agent-2"}',
].join('\n');

const TEST_RUN_ID = 'run-abc123';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tempCtxRoot: string;
let tempClaudeProjects: string;
let originalHome: string | undefined;

beforeEach(() => {
  const base = join(tmpdir(), `ctx-obs-test-${Date.now()}`);
  tempCtxRoot = join(base, 'ctx');

  // nativeWorkflowsBase() = join(homedir(), '.claude', 'projects')
  // We override HOME → base, so the journals must be at base/.claude/projects/...
  tempClaudeProjects = join(base, '.claude', 'projects');

  mkdirSync(tempCtxRoot, { recursive: true });
  mkdirSync(tempClaudeProjects, { recursive: true });

  // Write fixture journal into a session subdir that nativeWorkflowsBase() will scan.
  const workflowDir = join(
    tempClaudeProjects,
    'session-abc',
    'subagents',
    'workflows',
    TEST_RUN_ID,
  );
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, 'journal.jsonl'), FIXTURE_JOURNAL, 'utf-8');

  // Set CTX_ROOT for the observer's runtimes output.
  process.env['CTX_ROOT'] = tempCtxRoot;

  // Override HOME so nativeWorkflowsBase() → base/.claude/projects.
  originalHome = process.env['HOME'];
  process.env['HOME'] = base;

  // Reset shared mock state.
  __mockState.ledgerRuns = [];
  __mockState.discoveryEntries = [];
});

afterEach(() => {
  // Restore env.
  process.env['HOME'] = originalHome;
  delete process.env['CTX_ROOT'];

  // Clean up temp (base is the parent of ctx/ and .claude/).
  try {
    rmSync(join(tempCtxRoot, '..'), { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------

function seedRun(overrides: Partial<(typeof __mockState.ledgerRuns)[0]> = {}): void {
  __mockState.ledgerRuns.push({
    run_id: TEST_RUN_ID,
    idempotency_key: TEST_RUN_ID,
    native_id: undefined,
    epoch: 1,
    heartbeat: new Date().toISOString(),
    state: 'live',
    ...overrides,
  });
}

function recordPath(runId: string = TEST_RUN_ID): string {
  return join(tempCtxRoot, 'state', 'runtimes', `${runId}.json`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('observeOnce', () => {
  it('writes a boundary record to CTX_ROOT/state/runtimes/<run_id>.json', async () => {
    seedRun({ native_id: 'native-abc' });
    __mockState.discoveryEntries = [{ id: 'native-abc', state: 'working', cwd: '/tmp/proj' }];

    const { observeOnce } = await import('../../src/runtime/runtime-observer.js');
    await observeOnce();

    expect(existsSync(recordPath())).toBe(true);
    const record = JSON.parse(readFileSync(recordPath(), 'utf-8')) as RuntimeBoundaryRecord;
    expect(record.run_id).toBe(TEST_RUN_ID);
    expect(record.runtime).toBe('claude-bg');
    expect(typeof record.updated_at).toBe('string');
    // native_id should be carried through.
    expect(record.native_id).toBe('native-abc');
  });

  it('sets degraded: true when the tree contains a failed child (fixture sub-agent-2)', async () => {
    seedRun({ state: 'live' });

    const { observeOnce } = await import('../../src/runtime/runtime-observer.js');
    await observeOnce();

    expect(existsSync(recordPath())).toBe(true);
    const record = JSON.parse(readFileSync(recordPath(), 'utf-8')) as RuntimeBoundaryRecord;
    // sub-agent-2 is 'agent.failed' in fixture → isDegraded returns true.
    expect(record.degraded).toBe(true);
    // Tree should have the root node.
    expect(record.tree.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT produce a record for a run NOT in the ledger', async () => {
    // Ledger has only a different run — not TEST_RUN_ID.
    __mockState.ledgerRuns = [
      {
        run_id: 'other-run-999',
        idempotency_key: 'other-run-999',
        epoch: 1,
        heartbeat: new Date().toISOString(),
        state: 'live',
      },
    ];

    const { observeOnce } = await import('../../src/runtime/runtime-observer.js');
    await observeOnce();

    // TEST_RUN_ID record must NOT exist.
    expect(existsSync(recordPath(TEST_RUN_ID))).toBe(false);
  });

  it('degrades gracefully when the ledger is empty (no crash, no records)', async () => {
    // ledgerRuns stays empty.
    const { observeOnce } = await import('../../src/runtime/runtime-observer.js');
    await expect(observeOnce()).resolves.toBeUndefined();

    // No runtimes dir written (observeOnce ensureDir's it but no records).
    // The dir may or may not exist; what matters is no crash and no records.
    const runtimesDirPath = join(tempCtxRoot, 'state', 'runtimes');
    if (existsSync(runtimesDirPath)) {
      // Dir exists (ensureDir ran) but should have no .json files for our run.
      expect(existsSync(recordPath(TEST_RUN_ID))).toBe(false);
    }
  });

  it('degrades gracefully when the CLI is absent (no entries, no crash)', async () => {
    seedRun({ state: 'live' });
    // discoveryEntries stays [] — simulates CLI-absent.

    const { observeOnce } = await import('../../src/runtime/runtime-observer.js');
    await expect(observeOnce()).resolves.toBeUndefined();

    // Record should still be written (degraded, from ledger state).
    expect(existsSync(recordPath())).toBe(true);
    const record = JSON.parse(readFileSync(recordPath(), 'utf-8')) as RuntimeBoundaryRecord;
    expect(record.run_id).toBe(TEST_RUN_ID);
  });
});
