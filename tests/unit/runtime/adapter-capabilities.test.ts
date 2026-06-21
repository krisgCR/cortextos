/**
 * tests/unit/runtime/adapter-capabilities.test.ts
 *
 * Capability assertion tests for all runtime adapters.
 *
 * Validates that each adapter's capability envelope matches the N1.5 measured
 * values and stub configuration defined in the phase 3 plan.
 */

import { describe, expect, it } from 'vitest';
import {
  claudeBgAdapter,
  claudeDiscoveryAdapter,
  codexAppServerAdapter,
  codexExecAdapter,
  hermesAdapter,
  workflowObserverAdapter,
} from '../../../src/runtime/index.js';

// ---------------------------------------------------------------------------
// claude-bg adapter capabilities (N1.5 measured values)
// ---------------------------------------------------------------------------

describe('claudeBgAdapter capabilities', () => {
  it('observe.process === native', () => {
    expect(claudeBgAdapter.capabilities.observe.process).toBe('native');
  });

  it('observe.cost === degraded (60s OTel flush delay)', () => {
    expect(claudeBgAdapter.capabilities.observe.cost).toBe('degraded');
  });

  it('observe.descendants === native (subagent tree via workflow journal)', () => {
    expect(claudeBgAdapter.capabilities.observe.descendants).toBe('native');
  });

  it('control.submitTurn === none (SDK-only)', () => {
    expect(claudeBgAdapter.capabilities.control.submitTurn).toBe('none');
  });

  it('control.steerActiveTurn === none (SDK-only)', () => {
    expect(claudeBgAdapter.capabilities.control.steerActiveTurn).toBe('none');
  });

  it('control.interruptTurn === none (SDK-only)', () => {
    expect(claudeBgAdapter.capabilities.control.interruptTurn).toBe('none');
  });

  it('control.terminateRun === native (claude stop <id>, <1s)', () => {
    expect(claudeBgAdapter.capabilities.control.terminateRun).toBe('native');
  });

  it('control.drain === none', () => {
    expect(claudeBgAdapter.capabilities.control.drain).toBe('none');
  });

  it('recovery.resumeConversation === native (respawn)', () => {
    expect(claudeBgAdapter.capabilities.recovery.resumeConversation).toBe('native');
  });

  it('recovery.reattachLiveProcess === native (native supervisor owns PIDs)', () => {
    expect(claudeBgAdapter.capabilities.recovery.reattachLiveProcess).toBe('native');
  });

  it('recovery.rewindFiles === none', () => {
    expect(claudeBgAdapter.capabilities.recovery.rewindFiles).toBe('none');
  });

  it('recovery.adoptOrphan === native (agents --json --all by stable id)', () => {
    expect(claudeBgAdapter.capabilities.recovery.adoptOrphan).toBe('native');
  });

  it('isolation.root === worktree', () => {
    expect(claudeBgAdapter.capabilities.isolation.root).toBe('worktree');
  });

  it('isolation.descendants === runtime-defined', () => {
    expect(claudeBgAdapter.capabilities.isolation.descendants).toBe('runtime-defined');
  });

  it('runtime identifier === claude-bg', () => {
    expect(claudeBgAdapter.runtime).toBe('claude-bg');
  });
});

// ---------------------------------------------------------------------------
// codex-app-server adapter capabilities
// ---------------------------------------------------------------------------

describe('codexAppServerAdapter capabilities', () => {
  it('control.steerActiveTurn === native (unique to app-server)', () => {
    expect(codexAppServerAdapter.capabilities.control.steerActiveTurn).toBe('native');
  });

  it('control.submitTurn === native', () => {
    expect(codexAppServerAdapter.capabilities.control.submitTurn).toBe('native');
  });

  it('control.terminateRun === none', () => {
    expect(codexAppServerAdapter.capabilities.control.terminateRun).toBe('none');
  });

  it('isolation.root === cwd', () => {
    expect(codexAppServerAdapter.capabilities.isolation.root).toBe('cwd');
  });

  it('runtime identifier === codex-app-server', () => {
    expect(codexAppServerAdapter.runtime).toBe('codex-app-server');
  });
});

// ---------------------------------------------------------------------------
// codex-exec adapter capabilities
// ---------------------------------------------------------------------------

describe('codexExecAdapter capabilities', () => {
  it('control.steerActiveTurn === none (one-shot, no mid-run steering)', () => {
    expect(codexExecAdapter.capabilities.control.steerActiveTurn).toBe('none');
  });

  it('control.terminateRun === none', () => {
    expect(codexExecAdapter.capabilities.control.terminateRun).toBe('none');
  });

  it('observe.process === native', () => {
    expect(codexExecAdapter.capabilities.observe.process).toBe('native');
  });

  it('observe.turn === native', () => {
    expect(codexExecAdapter.capabilities.observe.turn).toBe('native');
  });

  it('observe.tool === none (one-shot, no tool streaming)', () => {
    expect(codexExecAdapter.capabilities.observe.tool).toBe('none');
  });

  it('observe.descendants === none (one-shot)', () => {
    expect(codexExecAdapter.capabilities.observe.descendants).toBe('none');
  });

  it('observe.cost === native', () => {
    expect(codexExecAdapter.capabilities.observe.cost).toBe('native');
  });

  it('runtime identifier === codex-exec', () => {
    expect(codexExecAdapter.runtime).toBe('codex-exec');
  });
});

// ---------------------------------------------------------------------------
// hermes adapter capabilities
// ---------------------------------------------------------------------------

describe('hermesAdapter capabilities', () => {
  it('all capabilities are unknown (not yet probed)', () => {
    const caps = hermesAdapter.capabilities;
    expect(caps.observe.process).toBe('unknown');
    expect(caps.observe.turn).toBe('unknown');
    expect(caps.observe.tool).toBe('unknown');
    expect(caps.observe.cost).toBe('unknown');
    expect(caps.control.steerActiveTurn).toBe('unknown');
    expect(caps.control.terminateRun).toBe('unknown');
    expect(caps.recovery.resumeConversation).toBe('unknown');
  });

  it('runtime identifier === hermes', () => {
    expect(hermesAdapter.runtime).toBe('hermes');
  });
});

// ---------------------------------------------------------------------------
// workflow-observer adapter capabilities
// ---------------------------------------------------------------------------

describe('workflowObserverAdapter capabilities', () => {
  it('all control.* === none (read-only observer)', () => {
    const ctrl = workflowObserverAdapter.capabilities.control;
    expect(ctrl.submitTurn).toBe('none');
    expect(ctrl.steerActiveTurn).toBe('none');
    expect(ctrl.interruptTurn).toBe('none');
    expect(ctrl.terminateRun).toBe('none');
    expect(ctrl.drain).toBe('none');
  });

  it('runtime identifier === workflow-observer', () => {
    expect(workflowObserverAdapter.runtime).toBe('workflow-observer');
  });
});

// ---------------------------------------------------------------------------
// claude-discovery adapter capabilities
// ---------------------------------------------------------------------------

describe('claudeDiscoveryAdapter capabilities', () => {
  it('all control.* === none (discovery/reconciliation only)', () => {
    const ctrl = claudeDiscoveryAdapter.capabilities.control;
    expect(ctrl.submitTurn).toBe('none');
    expect(ctrl.steerActiveTurn).toBe('none');
    expect(ctrl.interruptTurn).toBe('none');
    expect(ctrl.terminateRun).toBe('none');
    expect(ctrl.drain).toBe('none');
  });

  it('runtime identifier === claude-discovery', () => {
    expect(claudeDiscoveryAdapter.runtime).toBe('claude-discovery');
  });
});
