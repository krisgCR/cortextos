/**
 * N3 Phase 3 — pure runtime-tree.ts builder tests.
 *
 * No React, no side effects. Tests buildRuntimeTree, isRecordDegraded,
 * and nativeViewPath in isolation.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRuntimeTree,
  isRecordDegraded,
  nativeViewPath,
} from '@/lib/runtime-tree';
import type { RuntimeBoundaryRecord, AgentNode } from '@/lib/types';

// ---- Fixtures ----

const leafNode: AgentNode = {
  id: 'agent-1',
  label: 'Agent One',
  state: 'working',
  children: [],
  degraded: false,
};

const childNode: AgentNode = {
  id: 'agent-2',
  label: 'Agent Two',
  state: 'done',
  children: [],
  degraded: false,
};

const parentNode: AgentNode = {
  id: 'agent-root',
  label: 'Root Agent',
  state: 'working',
  children: [childNode],
  degraded: false,
};

function makeRecord(overrides: Partial<RuntimeBoundaryRecord> = {}): RuntimeBoundaryRecord {
  return {
    run_id: 'run-test-001',
    runtime: 'claude-bg',
    state: 'working',
    tree: [leafNode],
    degraded: false,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---- buildRuntimeTree ----

describe('buildRuntimeTree', () => {
  it('returns the record tree as-is', () => {
    const record = makeRecord({ tree: [leafNode] });
    const result = buildRuntimeTree(record);
    expect(result).toBe(record.tree);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('agent-1');
  });

  it('returns an empty array for a record with no tree nodes', () => {
    const record = makeRecord({ tree: [] });
    expect(buildRuntimeTree(record)).toEqual([]);
  });

  it('preserves nested children', () => {
    const record = makeRecord({ tree: [parentNode] });
    const result = buildRuntimeTree(record);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].id).toBe('agent-2');
  });

  it('handles multiple root nodes', () => {
    const record = makeRecord({ tree: [leafNode, parentNode] });
    const result = buildRuntimeTree(record);
    expect(result).toHaveLength(2);
    expect(result.map((n) => n.id)).toEqual(['agent-1', 'agent-root']);
  });
});

// ---- isRecordDegraded ----

describe('isRecordDegraded', () => {
  it('returns false when record.degraded is false', () => {
    expect(isRecordDegraded(makeRecord({ degraded: false }))).toBe(false);
  });

  it('returns true when record.degraded is true', () => {
    expect(isRecordDegraded(makeRecord({ degraded: true }))).toBe(true);
  });

  it('is unaffected by node-level degraded flags', () => {
    const degradedNode: AgentNode = { ...leafNode, degraded: true };
    const record = makeRecord({ tree: [degradedNode], degraded: false });
    expect(isRecordDegraded(record)).toBe(false);
  });
});

// ---- nativeViewPath ----

describe('nativeViewPath', () => {
  it('generates a full path when sessionId is provided', () => {
    const result = nativeViewPath('run-abc123', 'sess-xyz');
    expect(result).toBe('~/.claude/projects/sess-xyz/subagents/workflows/run-abc123/');
  });

  it('generates a wildcard path when sessionId is omitted', () => {
    const result = nativeViewPath('run-abc123');
    expect(result).toBe('~/.claude/.../workflows/run-abc123/');
  });

  it('includes the run_id in both forms', () => {
    const runId = 'run-unique-99';
    expect(nativeViewPath(runId, 'any-session')).toContain(runId);
    expect(nativeViewPath(runId)).toContain(runId);
  });

  it('path with sessionId starts with ~/.claude/projects/', () => {
    const result = nativeViewPath('run-1', 'session-42');
    expect(result.startsWith('~/.claude/projects/')).toBe(true);
  });

  it('path without sessionId starts with ~/.claude/.../', () => {
    const result = nativeViewPath('run-2');
    expect(result.startsWith('~/.claude/.../')).toBe(true);
  });
});
