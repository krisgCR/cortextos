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
  RunLeaseConflictError,
} from './run-authority.js';
export type { AgentsJsonEntry, ReconcileReport } from './run-authority.js';

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
export { workflowObserverAdapter } from './adapters/workflow-observer.js';
export { claudeDiscoveryAdapter } from './adapters/claude-discovery.js';
