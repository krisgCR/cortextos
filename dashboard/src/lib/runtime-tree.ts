// cortextOS Dashboard - Pure (no-React, no side-effects) tree model helpers (N3)
// Testable unit; import freely from server and client code alike.

import type { AgentNode, RuntimeBoundaryRecord } from './types';

/**
 * Build a display-ready agent node tree from a boundary record.
 * Currently a pass-through; add display transforms here as the model evolves.
 */
export function buildRuntimeTree(record: RuntimeBoundaryRecord): AgentNode[] {
  return record.tree;
}

/**
 * Derive degraded status for display from a boundary record.
 */
export function isRecordDegraded(record: RuntimeBoundaryRecord): boolean {
  return record.degraded;
}

/**
 * Build the local FS path to the native Anthropic workflow view for a run.
 * Returns a display-only string — NOT a URL or navigable href.
 *
 * Format: ~/.claude/projects/<sessionId>/subagents/workflows/<runId>/
 * Falls back to a wildcard form when sessionId is unknown.
 */
export function nativeViewPath(run_id: string, sessionId?: string): string {
  if (sessionId) {
    return `~/.claude/projects/${sessionId}/subagents/workflows/${run_id}/`;
  }
  return `~/.claude/.../workflows/${run_id}/`;
}
