/**
 * tests/unit/runtime/workflow-observer.test.ts
 *
 * Pure parse function tests for the workflow-observer adapter.
 *
 * Tests: parseJournalEntry, parseWorkflowJournal, isDegraded
 * Uses fixture content from tests/fixtures/runtime/workflows/run-abc123/
 *
 * Does NOT import the adapter object — imports parse functions directly.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  isDegraded,
  parseJournalEntry,
  parseWorkflowJournal,
} from '../../../src/runtime/adapters/workflow-observer.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(
  new URL('..', import.meta.url).pathname,
  '../fixtures/runtime/workflows/run-abc123',
);

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8');
}

// ---------------------------------------------------------------------------
// parseJournalEntry
// ---------------------------------------------------------------------------

describe('parseJournalEntry', () => {
  it('parses agent.started → working node', () => {
    const node = parseJournalEntry(
      JSON.stringify({ type: 'agent.started', agentId: 'agent-1', label: 'my task' }),
    );
    expect(node).not.toBeNull();
    expect(node!.id).toBe('agent-1');
    expect(node!.label).toBe('my task');
    expect(node!.state).toBe('working');
    expect(node!.degraded).toBe(false);
  });

  it('parses agent.stopped with state done', () => {
    const node = parseJournalEntry(
      JSON.stringify({ type: 'agent.stopped', agentId: 'agent-2', state: 'done' }),
    );
    expect(node).not.toBeNull();
    expect(node!.state).toBe('done');
  });

  it('parses agent.failed → failed node', () => {
    const node = parseJournalEntry(
      JSON.stringify({ type: 'agent.failed', agentId: 'agent-3' }),
    );
    expect(node).not.toBeNull();
    expect(node!.state).toBe('failed');
  });

  it('returns null for unknown type (schema-drift defense)', () => {
    const node = parseJournalEntry(
      JSON.stringify({ type: 'unknown.event', agentId: 'agent-4' }),
    );
    expect(node).toBeNull();
  });

  it('returns null for empty line', () => {
    expect(parseJournalEntry('')).toBeNull();
    expect(parseJournalEntry('   ')).toBeNull();
  });

  it('returns null for malformed JSON (never throws)', () => {
    expect(parseJournalEntry('{ bad json ')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseJournalEntry('"a string"')).toBeNull();
    expect(parseJournalEntry('42')).toBeNull();
  });

  it('falls back to id as label when label absent', () => {
    const node = parseJournalEntry(
      JSON.stringify({ type: 'agent.started', agentId: 'agent-no-label' }),
    );
    expect(node).not.toBeNull();
    expect(node!.label).toBe('agent-no-label');
  });
});

// ---------------------------------------------------------------------------
// parseWorkflowJournal
// ---------------------------------------------------------------------------

describe('parseWorkflowJournal', () => {
  it('reconstructs a root node with two children from fixture journal', () => {
    const content = readFixture('journal.jsonl');
    const tree = parseWorkflowJournal(content);

    // Should have exactly one root node (root-agent).
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(root.id).toBe('root-agent');
    expect(root.label).toBe('main task agent');

    // Two children.
    expect(root.children).toHaveLength(2);
    const ids = root.children.map((c) => c.id).sort();
    expect(ids).toEqual(['sub-agent-1', 'sub-agent-2']);
  });

  it('applies last-write-wins: sub-agent-1 ends as done, sub-agent-2 as failed', () => {
    const content = readFixture('journal.jsonl');
    const tree = parseWorkflowJournal(content);
    const root = tree[0]!;

    const sub1 = root.children.find((c) => c.id === 'sub-agent-1');
    const sub2 = root.children.find((c) => c.id === 'sub-agent-2');

    expect(sub1).toBeDefined();
    expect(sub2).toBeDefined();
    expect(sub1!.state).toBe('done');
    expect(sub2!.state).toBe('failed');
  });

  it('skips unknown journal line types without throwing', () => {
    // The fixture contains an unknown.event line — should be skipped silently.
    const content = readFixture('journal.jsonl');
    const tree = parseWorkflowJournal(content);
    // Tree still reconstructed despite unknown line.
    expect(tree).toHaveLength(1);
  });

  it('returns [] for empty journal', () => {
    const tree = parseWorkflowJournal('');
    expect(tree).toHaveLength(0);
  });

  it('returns [] for all-unknown journal', () => {
    const content = '{"type":"custom.event","agentId":"x"}\n{"type":"another.event"}';
    const tree = parseWorkflowJournal(content);
    expect(tree).toHaveLength(0);
  });

  it('tolerates malformed JSONL lines (never throws)', () => {
    const content =
      '{"type":"agent.started","agentId":"a","label":"a"}\n{ invalid }\n{"type":"agent.stopped","agentId":"a","state":"done"}';
    expect(() => parseWorkflowJournal(content)).not.toThrow();
    const tree = parseWorkflowJournal(content);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.state).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// isDegraded
// ---------------------------------------------------------------------------

describe('isDegraded', () => {
  it('returns false for an all-healthy tree', () => {
    const content = readFixture('agent-sub1.jsonl');
    const nodes = parseWorkflowJournal(content);
    // sub1 journal has started → stopped (done), no failures.
    expect(isDegraded(nodes)).toBe(false);
  });

  it('returns true when any node has state failed (fixture with failed child)', () => {
    const content = readFixture('journal.jsonl');
    const tree = parseWorkflowJournal(content);
    // sub-agent-2 is failed → isDegraded should be true.
    expect(isDegraded(tree)).toBe(true);
  });

  it('returns true when a node has degraded: true', () => {
    const tree = [
      {
        id: 'a',
        label: 'a',
        state: 'working' as const,
        children: [
          {
            id: 'b',
            label: 'b',
            state: 'working' as const,
            children: [],
            degraded: true,
          },
        ],
        degraded: false,
      },
    ];
    expect(isDegraded(tree)).toBe(true);
  });

  it('returns false for empty tree', () => {
    expect(isDegraded([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real capability grades on workflowObserverAdapter
// ---------------------------------------------------------------------------

describe('workflowObserverAdapter capabilities', () => {
  it('observe.descendants === degraded (journal-based, not native)', async () => {
    const { workflowObserverAdapter } = await import(
      '../../../src/runtime/adapters/workflow-observer.js'
    );
    expect(workflowObserverAdapter.capabilities.observe.descendants).toBe('degraded');
  });

  it('observe.cost === none (no cost data in journals)', async () => {
    const { workflowObserverAdapter } = await import(
      '../../../src/runtime/adapters/workflow-observer.js'
    );
    expect(workflowObserverAdapter.capabilities.observe.cost).toBe('none');
  });

  it('dispatch still throws NotImplemented', async () => {
    const { workflowObserverAdapter } = await import(
      '../../../src/runtime/adapters/workflow-observer.js'
    );
    expect(() =>
      workflowObserverAdapter.dispatch({} as Parameters<typeof workflowObserverAdapter.dispatch>[0]),
    ).toThrow('NotImplemented');
  });
});
