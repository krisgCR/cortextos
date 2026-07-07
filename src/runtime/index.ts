/**
 * src/runtime — Runtime-boundary protocol barrel.
 *
 * Exports all public APIs from the runtime sub-package.
 * Adapters (claude-bg, codex-app-server, hermes, …) are re-exported
 * from this barrel once implemented.
 */

export { makeCapabilities, DEFAULT_CAPABILITY_METADATA } from './capabilities.js';
export {
  recordRun,
  acquireLease,
  touchHeartbeat,
  reconcile,
  allRecords,
  requestCancel,
  reissueTermination,
  RunLeaseConflictError,
} from './run-authority.js';
export type {
  AgentsJsonEntry,
  ReconcileReport,
  RunRecord,
  CancelIntentResult,
  TerminateEscalationOpts,
  TerminateEscalationResult,
} from './run-authority.js';

// Runtime adapters
export {
  claudeBgAdapter,
  parseAgentsJson,
  parseHookEvent,
  entrypointToBillingPool,
  AgentsJsonParseError,
  HookEventParseError,
} from './adapters/claude-bg.js';
export { codexAppServerAdapter } from './adapters/codex-app-server.js';
export { codexExecAdapter } from './adapters/codex-exec.js';
export { hermesAdapter } from './adapters/hermes.js';
export { workflowObserverAdapter, parseJournalEntry, parseWorkflowJournal, isDegraded } from './adapters/workflow-observer.js';
export { claudeDiscoveryAdapter, parseAgentsJson as parseDiscoveryAgentsJson, spawnAgentsCli } from './adapters/claude-discovery.js';

// Runtime observer (observe-only reconciler)
export { observeOnce, startRuntimeObserver } from './runtime-observer.js';

// Run watchdog (Phase 0a Task 3.1 deadline / Task 3.2 stall)
export {
  runDeadlineSweep,
  runStallSweep,
  startRunWatchdogLoop,
  NO_ACTIVITY_SIGNAL_SOURCE,
} from './run-watchdog.js';
export type { ActivitySource, WatchdogSweepResult } from './run-watchdog.js';
