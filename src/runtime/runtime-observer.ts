/**
 * src/runtime/runtime-observer.ts
 *
 * Observe-only reconciler for the D24 runtime-boundary protocol.
 *
 * Responsibilities:
 *   1. Polls `claude agents --json --all` via claudeDiscoveryAdapter (discovery pass).
 *   2. Reads workflow journals under CTX_ROOT/state/runtimes/ for ledger-correlated sessions.
 *   3. Normalizes each run into a RuntimeBoundaryRecord and atomic-writes it to
 *      CTX_ROOT/state/runtimes/<run_id>.json.
 *
 * Privacy / blast-radius gate:
 *   Only runs appearing in run-authority.allRecords() produce boundary records.
 *   Unrelated ~/.claude projects do not surface.
 *
 * OBSERVE-ONLY: No dispatch, no spawn, no control surface anywhere in this module.
 *
 * Exports:
 *   observeOnce()                   — single observation pass
 *   startRuntimeObserver(intervalMs) — returns a stop function (setInterval-based)
 *
 * CTX_ROOT resolution:
 *   process.env.CTX_ROOT ?? os.homedir() + '/.claude'
 *
 * On-disk record:  CTX_ROOT/state/runtimes/<run_id>.json
 */

import * as fs from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import type { RuntimeBoundaryRecord } from '../types/index.js';
import { allRecords } from './run-authority.js';
import { spawnAgentsCli, parseAgentsJson as parseDiscoveryAgentsJson } from './adapters/claude-discovery.js';
import { parseWorkflowJournal, isDegraded } from './adapters/workflow-observer.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function ctxRoot(): string {
  return process.env['CTX_ROOT'] ?? join(homedir(), '.claude');
}

function runtimesDir(): string {
  return join(ctxRoot(), 'state', 'runtimes');
}

function runtimeRecordPath(runId: string): string {
  return join(runtimesDir(), `${runId}.json`);
}

/**
 * Base path for native Claude workflow journals.
 * Pattern: ~/.claude/projects/<session>/subagents/workflows/<runId>/
 */
function nativeWorkflowsBase(): string {
  return join(homedir(), '.claude', 'projects');
}

// ---------------------------------------------------------------------------
// Journal reading (best-effort, never throws)
// ---------------------------------------------------------------------------

/**
 * Attempt to read a journal file, returning its contents or null on error.
 */
function tryReadJournal(journalPath: string): string | null {
  try {
    return fs.readFileSync(journalPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Walk all session dirs under `~/.claude/projects/` and find workflow journals
 * that match the given runId.
 *
 * Returns { journalContent, sessionDir } for the first match found, or null.
 * This is a best-effort search — it may miss journals in very large trees,
 * but never throws.
 */
function findJournalForRun(runId: string): {
  journalContent: string;
  sessionDir: string;
} | null {
  const base = nativeWorkflowsBase();
  if (!fs.existsSync(base)) return null;

  let sessionDirs: string[];
  try {
    sessionDirs = fs.readdirSync(base);
  } catch {
    return null;
  }

  for (const sessionId of sessionDirs) {
    const workflowsDir = join(base, sessionId, 'subagents', 'workflows', runId);
    const journalPath = join(workflowsDir, 'journal.jsonl');
    const content = tryReadJournal(journalPath);
    if (content !== null) {
      return { journalContent: content, sessionDir: join(base, sessionId) };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Observation logic
// ---------------------------------------------------------------------------

/**
 * Perform a single observation pass:
 *
 * 1. Ensure the runtimes output dir exists (so the dashboard watcher picks it up).
 * 2. Poll `claude agents --json --all` for the live discovery snapshot.
 * 3. For each run in the run-authority ledger (privacy gate):
 *    a. Find matching native entry from discovery snapshot.
 *    b. Attempt to read the workflow journal.
 *    c. Parse journal into an AgentNode tree.
 *    d. Derive degraded flag.
 *    e. Atomic-write the RuntimeBoundaryRecord to CTX_ROOT/state/runtimes/<run_id>.json.
 */
export async function observeOnce(): Promise<void> {
  ensureDir(runtimesDir());

  // Step 1: Discovery snapshot — gracefully returns [] if CLI is absent.
  const { entries: discoveryEntries } = await spawnAgentsCli();

  // Build a lookup map: native_id → entry, sessionId → entry.
  const byNativeId = new Map<string, (typeof discoveryEntries)[number]>();
  const bySessionId = new Map<string, (typeof discoveryEntries)[number]>();
  for (const entry of discoveryEntries) {
    byNativeId.set(entry.id, entry);
    if (entry.sessionId) bySessionId.set(entry.sessionId, entry);
  }

  // Step 2: Ledger-gated — only process runs known to this cortextOS instance.
  // We use a dummy instanceId-free approach: CTX_ROOT is instance-scoped,
  // so we read the instance's ledger dir. The instanceId in ledgerDir() is
  // relative to ~/.cortextos/<instanceId>; but CTX_ROOT already IS the instance root.
  //
  // run-authority uses `homedir()/.cortextos/<instanceId>/state/runs` for the ledger.
  // We can't derive instanceId from CTX_ROOT alone without convention.
  // Convention: CTX_ROOT env is set to `~/.cortextos/<instanceId>` by the daemon.
  // The ledger dir is at `<CTX_ROOT>/../<instanceId>/state/runs`, but for simplicity
  // the daemon sets CTX_ROOT = instanceRoot = `~/.cortextos/<instanceId>`.
  //
  // allRecords(instanceId) takes the instanceId string for path construction.
  // We derive instanceId from CTX_ROOT basename.
  const instanceRoot = ctxRoot();
  const instanceId = instanceRoot.split('/').pop() ?? 'default';

  let ledgerRuns: ReturnType<typeof allRecords>;
  try {
    ledgerRuns = allRecords(instanceId);
  } catch {
    ledgerRuns = [];
  }

  // Step 3: For each ledger run, produce a boundary record.
  for (const run of ledgerRuns) {
    // Match native entry by native_id or run_id (used as sessionId fallback).
    const nativeEntry =
      (run.native_id ? byNativeId.get(run.native_id) : undefined) ??
      bySessionId.get(run.run_id) ??
      null;

    // Map run state: prefer native discovery state; fall back to ledger state.
    let state: RuntimeBoundaryRecord['state'];
    if (nativeEntry) {
      const mapped = parseDiscoveryAgentsJson(
        JSON.stringify([{ id: nativeEntry.id, state: nativeEntry.state }]),
      );
      // Use the first entry's state from the parsed result.
      const parsed = mapped[0];
      if (parsed) {
        const ns = parsed.state;
        // parsed.state is AgentsJsonEntry.state (raw string); map to boundary record state.
        state = mapToRecordState(ns);
      } else {
        state = mapLedgerState(run.state);
      }
    } else {
      state = mapLedgerState(run.state);
    }

    // Read workflow journal (best-effort).
    const journalResult = findJournalForRun(run.run_id);
    let tree: RuntimeBoundaryRecord['tree'] = [];
    let treeDegraded = false;

    if (journalResult) {
      tree = parseWorkflowJournal(journalResult.journalContent);
      treeDegraded = isDegraded(tree);
    } else {
      // No journal found — degrade if the run is/was live (it should have one).
      treeDegraded = run.state === 'live' || run.state === 'pending';
    }

    const record: RuntimeBoundaryRecord = {
      run_id: run.run_id,
      runtime: 'claude-bg', // native Claude runs are always claude-bg
      state,
      tree,
      degraded: treeDegraded,
      updated_at: new Date().toISOString(),
      native_id: nativeEntry?.id ?? run.native_id,
      cwd: nativeEntry?.cwd ?? run.worktree,
    };

    atomicWriteSync(runtimeRecordPath(run.run_id), JSON.stringify(record, null, 2));
  }
}

// ---------------------------------------------------------------------------
// State mappers
// ---------------------------------------------------------------------------

function mapLedgerState(
  ledgerState: 'pending' | 'live' | 'done' | 'orphaned',
): RuntimeBoundaryRecord['state'] {
  switch (ledgerState) {
    case 'pending':
      return 'working';
    case 'live':
      return 'working';
    case 'done':
      return 'done';
    case 'orphaned':
      return 'stopped';
    default:
      return 'unknown';
  }
}

function mapToRecordState(rawState: string): RuntimeBoundaryRecord['state'] {
  switch (rawState) {
    case 'working':
    case 'running':
    case 'active':
      return 'working';
    case 'blocked':
    case 'waiting':
      return 'blocked';
    case 'done':
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Polling observer
// ---------------------------------------------------------------------------

/**
 * Start the runtime observer on an interval.
 *
 * Returns a stop function — call it to clear the interval.
 * Default interval: 30 seconds.
 */
export function startRuntimeObserver(intervalMs: number = 30_000): () => void {
  // Run immediately on start.
  void observeOnce().catch((err: unknown) => {
    console.error('[runtime-observer] observeOnce error:', err);
  });

  const handle = setInterval(() => {
    void observeOnce().catch((err: unknown) => {
      console.error('[runtime-observer] observeOnce error:', err);
    });
  }, intervalMs);

  return () => {
    clearInterval(handle);
  };
}
