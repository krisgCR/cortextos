// cortextOS Dashboard - Chokidar file watcher singleton
// Monitors CTX_ROOT for JSON/JSONL changes, syncs to SQLite, emits SSE events.

import { EventEmitter } from 'events';
import { existsSync, readFileSync } from 'fs';
import { watch, type FSWatcher } from 'chokidar';
import path from 'path';
import { CTX_ROOT, getOrgs } from './config';
import { syncFile, syncAll } from './sync';
import { getHealthStatus } from './data/heartbeats';
import type { SSEEvent, Heartbeat } from './types';

// ---------------------------------------------------------------------------
// globalThis singleton pattern (survives Next.js hot reloads)
// ---------------------------------------------------------------------------

const globalForWatcher = globalThis as unknown as {
  __cortextos_emitter: EventEmitter | undefined;
  __cortextos_watcher: FSWatcher | undefined;
};

export const emitter: EventEmitter =
  globalForWatcher.__cortextos_emitter ?? new EventEmitter();
emitter.setMaxListeners(100); // support many concurrent SSE clients

if (process.env.NODE_ENV !== 'production') {
  globalForWatcher.__cortextos_emitter = emitter;
}

// ---------------------------------------------------------------------------
// Watch path builder
// ---------------------------------------------------------------------------

// chokidar v5 dropped glob support, so glob patterns passed to watch() silently
// match nothing — the dashboard would never live-update. Instead we watch the
// stable parent directories (chokidar is recursive by default) and narrow to the
// files we care about in handleFileChange via isRelevantPath().
function getWatchPaths(): string[] {
  const candidates: string[] = [];
  const orgs = getOrgs();

  for (const org of orgs) {
    const orgBase = path.join(CTX_ROOT, 'orgs', org);
    candidates.push(path.join(orgBase, 'tasks'));
    candidates.push(path.join(orgBase, 'approvals'));
    candidates.push(path.join(orgBase, 'analytics', 'events'));
  }

  // Flat dirs (not org-scoped)
  // NOTE: CTX_ROOT/state is watched recursively, which already covers
  // state/runtimes/*.json written by the runtime observer (N3 producer).
  // No additional watch path is needed; ensureDir in the producer creates
  // the state/runtimes/ subdirectory at observer startup.
  candidates.push(path.join(CTX_ROOT, 'state'));
  candidates.push(path.join(CTX_ROOT, 'inbox'));

  // Only watch dirs that exist now: chokidar won't fire for a path created after
  // init, which mirrors the prior glob-base behaviour (the glob base dir also had
  // to exist). The watcher re-inits on dashboard restart to pick up new dirs.
  return candidates.filter((dir) => existsSync(dir));
}

// With directory watching, handleFileChange receives every file under the watched
// trees. Mirror the old glob scope: only heartbeat.json and the three
// event-bearing file shapes are synced/emitted; everything else is ignored.
function isRelevantPath(filePath: string): boolean {
  if (filePath.endsWith('/heartbeat.json')) return true;
  if (filePath.includes('/tasks/') && filePath.endsWith('.json')) return true;
  if (filePath.includes('/approvals/') && filePath.endsWith('.json')) return true;
  if (filePath.includes('/analytics/events/') && filePath.endsWith('.jsonl')) return true;
  if (filePath.includes('/inbox/') && filePath.endsWith('.json')) return true;
  if (filePath.includes('/state/runtimes/') && filePath.endsWith('.json')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// File change handler
// ---------------------------------------------------------------------------

function categorizeFilePath(filePath: string): SSEEvent['type'] {
  if (filePath.includes('/tasks/')) return 'task';
  if (filePath.includes('/approvals/')) return 'approval';
  if (filePath.includes('/heartbeat.json')) return 'heartbeat';
  if (filePath.includes('/analytics/events/')) return 'event';
  if (filePath.includes('/state/runtimes/')) return 'runtime';
  return 'sync';
}

// Exported for the heartbeat-SSE payload contract test (P2a C5): the unit that
// builds the SSE payload, tested directly so the assertion doesn't depend on
// chokidar's awaitWriteFinish latency (an end-to-end watcher test covers the
// init → emit path separately).
export function handleFileChange(
  filePath: string,
  changeType: 'change' | 'add' | 'remove',
): void {
  // chokidar v5 watches whole dirs; drop anything outside the tracked file shapes.
  if (!isRelevantPath(filePath)) return;

  console.log(`[watcher] ${changeType}: ${filePath}`);

  // Sync the changed file to SQLite (skip for deletions)
  if (changeType !== 'remove') {
    try {
      syncFile(filePath);
    } catch (err) {
      console.error(`[watcher] Sync failed for ${filePath}:`, err);
    }
  }

  // Emit SSE event
  const eventType = categorizeFilePath(filePath);
  const data: Record<string, unknown> = { filePath, changeType };

  // Enrich heartbeat events so agents-grid can update health in place.
  // The grid reads event.data.agent + event.data.health; without these the
  // live-update handler early-returns and the grid never updates.
  if (eventType === 'heartbeat' && changeType !== 'remove') {
    const agentName = path.basename(path.dirname(filePath));
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const hbRaw = JSON.parse(raw);
      const hb: Heartbeat = {
        agent: agentName,
        org: hbRaw.org ?? '',
        status: hbRaw.status ?? 'unknown',
        current_task: hbRaw.current_task ?? undefined,
        last_heartbeat: hbRaw.last_heartbeat ?? hbRaw.timestamp ?? undefined,
      };
      data.agent = agentName;
      data.health = getHealthStatus(hb);
      data.current_task = hb.current_task;
    } catch {
      // Non-fatal: emit with filePath/changeType only — grid will stay stale until next reload.
    }
  }

  const sseEvent: SSEEvent = {
    type: eventType,
    data,
    timestamp: new Date().toISOString(),
  };

  emitter.emit('sse', sseEvent);
}

// ---------------------------------------------------------------------------
// Watcher factory
// ---------------------------------------------------------------------------

function createWatcher(): FSWatcher {
  const watchPaths = getWatchPaths();

  if (watchPaths.length === 0) {
    console.warn(
      '[watcher] No paths to watch - CTX_ROOT may not have any orgs yet',
    );
  }

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    persistent: true,
    // Don't descend into per-agent binary/runtime noise under state/ (codex
    // sockets, managed CODEX_HOME) or any vendored deps — isRelevantPath would
    // drop them anyway, this just keeps the watch set lean.
    ignored: (p: string) =>
      p.includes('/node_modules/') ||
      p.includes('/codex-home/') ||
      p.endsWith('.sock'),
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('add', (fp) => handleFileChange(fp, 'add'));
  watcher.on('change', (fp) => handleFileChange(fp, 'change'));
  watcher.on('unlink', (fp) => handleFileChange(fp, 'remove'));
  watcher.on('error', (error) => console.error('[watcher] Error:', error));

  console.log(
    `[watcher] Watching ${watchPaths.length} directories under ${CTX_ROOT}`,
  );
  return watcher;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the file watcher singleton.
 * Runs a full sync on first call, then starts watching for incremental changes.
 */
export function initWatcher(): FSWatcher {
  if (globalForWatcher.__cortextos_watcher) {
    return globalForWatcher.__cortextos_watcher;
  }

  console.log('[watcher] Running initial full sync...');
  syncAll();

  const watcher = createWatcher();

  if (process.env.NODE_ENV !== 'production') {
    globalForWatcher.__cortextos_watcher = watcher;
  }

  return watcher;
}

/**
 * Gracefully close the watcher.
 */
export function stopWatcher(): void {
  if (globalForWatcher.__cortextos_watcher) {
    globalForWatcher.__cortextos_watcher.close();
    globalForWatcher.__cortextos_watcher = undefined;
  }
}

/**
 * Subscribe to SSE events. Returns an unsubscribe function.
 */
export function onSSEEvent(
  handler: (event: SSEEvent) => void,
): () => void {
  emitter.on('sse', handler);
  return () => emitter.off('sse', handler);
}

// Graceful shutdown on process exit
if (typeof process !== 'undefined') {
  const shutdown = () => {
    stopWatcher();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
