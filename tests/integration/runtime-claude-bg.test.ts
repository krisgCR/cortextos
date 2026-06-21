/**
 * tests/integration/runtime-claude-bg.test.ts
 *
 * Integration tests for the claude-bg RuntimeDriver adapter.
 *
 * Tests cover:
 *   - parseAgentsJson: valid payload → RunStatus
 *   - parseAgentsJson: malformed payload → AgentsJsonParseError
 *   - parseHookEvent: valid Stop hook → RuntimeEvent (kind: 'lifecycle')
 *   - parseHookEvent: invalid payload (missing session_id) → HookEventParseError
 *   - dispatch: always throws (gated-closed, N4 not yet live)
 */

import { describe, expect, it } from 'vitest';
import {
  AgentsJsonParseError,
  claudeBgAdapter,
  HookEventParseError,
  parseAgentsJson,
  parseHookEvent,
} from '../../src/runtime/adapters/claude-bg.js';
import type { RunSpec } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// parseAgentsJson
// ---------------------------------------------------------------------------

describe('parseAgentsJson', () => {
  it('valid agents --json payload → RunStatus with correct run_id and state', () => {
    const raw = {
      id: 'agent-abc-123',
      state: 'working',
      kind: 'background',
      cwd: '/home/user/project',
    };

    const status = parseAgentsJson(raw);

    expect(status.run_id).toBe('agent-abc-123');
    expect(status.state).toBe('working');
    expect(status.billing_pool).toBe('subscription');
    expect(typeof status.heartbeat).toBe('string');
    // state must be one of the allowed RunStatus states
    expect(['working', 'blocked', 'done', 'failed', 'stopped']).toContain(status.state);
  });

  it('maps state "completed" → "done"', () => {
    const status = parseAgentsJson({ id: 'run-1', state: 'completed' });
    expect(status.state).toBe('done');
  });

  it('maps state "waiting" → "blocked"', () => {
    const status = parseAgentsJson({ id: 'run-2', state: 'waiting' });
    expect(status.state).toBe('blocked');
  });

  it('maps state "failed" → "failed"', () => {
    const status = parseAgentsJson({ id: 'run-3', state: 'failed' });
    expect(status.state).toBe('failed');
  });

  it('maps state "stopped" → "stopped"', () => {
    const status = parseAgentsJson({ id: 'run-4', state: 'stopped' });
    expect(status.state).toBe('stopped');
  });

  it('maps unknown state → "working" (safe default)', () => {
    const status = parseAgentsJson({ id: 'run-5', state: 'something-new' });
    expect(status.state).toBe('working');
  });

  it('malformed payload (missing id) → throws AgentsJsonParseError', () => {
    expect(() => parseAgentsJson({ state: 'working' })).toThrow(AgentsJsonParseError);
    expect(() => parseAgentsJson({ state: 'working' })).toThrow(/id/);
  });

  it('malformed payload (missing state) → throws AgentsJsonParseError', () => {
    expect(() => parseAgentsJson({ id: 'run-6' })).toThrow(AgentsJsonParseError);
    expect(() => parseAgentsJson({ id: 'run-6' })).toThrow(/state/);
  });

  it('non-object input → throws AgentsJsonParseError', () => {
    expect(() => parseAgentsJson(null)).toThrow(AgentsJsonParseError);
    expect(() => parseAgentsJson('string')).toThrow(AgentsJsonParseError);
    expect(() => parseAgentsJson(42)).toThrow(AgentsJsonParseError);
  });

  it('error carries raw input', () => {
    const bad = { state: 'working' }; // missing id
    let caught: AgentsJsonParseError | undefined;
    try {
      parseAgentsJson(bad);
    } catch (e) {
      caught = e as AgentsJsonParseError;
    }
    expect(caught).toBeDefined();
    expect(caught!.raw).toBe(bad);
    expect(caught!.name).toBe('AgentsJsonParseError');
  });
});

// ---------------------------------------------------------------------------
// parseHookEvent
// ---------------------------------------------------------------------------

describe('parseHookEvent', () => {
  it('valid Stop hook event → RuntimeEvent with kind "lifecycle"', () => {
    const raw = { session_id: 'sess-123', hook_name: 'Stop' };

    const event = parseHookEvent(raw);

    expect(event.session_id).toBe('sess-123');
    expect(event.run_id).toBe('sess-123'); // session_id IS the run correlation key
    expect(event.kind).toBe('lifecycle');
    expect(typeof event.timestamp).toBe('string');
    expect(event.payload).toEqual(raw);
  });

  it('UserPromptSubmit hook → kind "turn"', () => {
    const event = parseHookEvent({ session_id: 'sess-abc', hook_name: 'UserPromptSubmit' });
    expect(event.kind).toBe('turn');
  });

  it('PostToolUse hook → kind "turn"', () => {
    const event = parseHookEvent({ session_id: 'sess-abc', hook_name: 'PostToolUse' });
    expect(event.kind).toBe('turn');
  });

  it('PreToolUse hook → kind "tool-call"', () => {
    const event = parseHookEvent({ session_id: 'sess-abc', hook_name: 'PreToolUse' });
    expect(event.kind).toBe('tool-call');
  });

  it('unknown hook_name → kind "lifecycle" (safe default)', () => {
    const event = parseHookEvent({ session_id: 'sess-abc', hook_name: 'SomeFuture' });
    expect(event.kind).toBe('lifecycle');
  });

  it('missing hook_name → kind "lifecycle" (safe default)', () => {
    const event = parseHookEvent({ session_id: 'sess-abc' });
    expect(event.kind).toBe('lifecycle');
  });

  it('invalid payload (missing session_id) → throws HookEventParseError', () => {
    expect(() => parseHookEvent({ hook_name: 'Stop' })).toThrow(HookEventParseError);
    expect(() => parseHookEvent({ hook_name: 'Stop' })).toThrow(/session_id/);
  });

  it('non-object input → throws HookEventParseError', () => {
    expect(() => parseHookEvent(null)).toThrow(HookEventParseError);
    expect(() => parseHookEvent('string')).toThrow(HookEventParseError);
  });

  it('error carries raw input', () => {
    const bad = { hook_name: 'Stop' }; // missing session_id
    let caught: HookEventParseError | undefined;
    try {
      parseHookEvent(bad);
    } catch (e) {
      caught = e as HookEventParseError;
    }
    expect(caught).toBeDefined();
    expect(caught!.raw).toBe(bad);
    expect(caught!.name).toBe('HookEventParseError');
  });
});

// ---------------------------------------------------------------------------
// dispatch — gated-closed
// ---------------------------------------------------------------------------

describe('claudeBgAdapter.dispatch', () => {
  it('always throws (gated-closed, N4 not yet live)', async () => {
    const spec: RunSpec = {
      run_id: 'test-run-1',
      runtime: 'claude-bg',
      model: 'claude-opus-4-5',
      cwd: '/tmp/test',
      idempotency_key: 'test-idem-key',
      billing_pool: 'subscription',
    };

    await expect(claudeBgAdapter.dispatch(spec)).rejects.toThrow(/gated-closed/);
  });
});
