// cortextOS Dashboard - Runtime boundary record data accessor (N3)
// Reads from the SQLite runtimes table populated by syncRuntime() in sync.ts.

import { db } from '../db';
import type { RuntimeBoundaryRecord, AgentNode } from '../types';

interface RuntimeRow {
  run_id: string;
  runtime: string;
  state: string;
  tree: string;
  degraded: number;
  updated_at: string;
  native_id: string | null;
  cwd: string | null;
}

function rowToRecord(row: RuntimeRow): RuntimeBoundaryRecord {
  return {
    run_id: row.run_id,
    runtime: row.runtime as RuntimeBoundaryRecord['runtime'],
    state: row.state as RuntimeBoundaryRecord['state'],
    tree: JSON.parse(row.tree) as AgentNode[],
    degraded: row.degraded !== 0,
    updated_at: row.updated_at,
    native_id: row.native_id ?? undefined,
    cwd: row.cwd ?? undefined,
  };
}

/**
 * Get all runtime boundary records, ordered by most recently observed.
 */
export function getRuntimes(): RuntimeBoundaryRecord[] {
  const rows = db
    .prepare('SELECT * FROM runtimes ORDER BY updated_at DESC')
    .all() as RuntimeRow[];
  return rows.map(rowToRecord);
}

/**
 * Get the agent tree for a specific run. Returns null if the run is not found.
 */
export function getRuntimeTree(run_id: string): AgentNode[] | null {
  const row = db
    .prepare('SELECT tree FROM runtimes WHERE run_id = ?')
    .get(run_id) as Pick<RuntimeRow, 'tree'> | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.tree) as AgentNode[];
  } catch {
    return null;
  }
}
