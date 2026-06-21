/**
 * P2a Phase 3 contract: the heartbeat SSE payload fix (Codex review C5).
 *
 * Before the fix the watcher emitted only `{ filePath, changeType }` for a
 * heartbeat change, while agents-grid reads `event.data.agent` + `.health` —
 * so the live-update handler early-returned and the grid was a latent no-op.
 * This pins the enrichment: a heartbeat change now emits `{ agent, health,
 * current_task }`, with `health` derived through the real getHealthStatus.
 *
 * handleFileChange is exercised directly (not via initWatcher): chokidar v5
 * dropped glob support, so the watcher's glob watch-paths can't drive the
 * handler deterministically in a test. './sync' is mocked so the handler's
 * syncFile() call doesn't touch SQLite; the categorize + enrich path under test
 * runs for real.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SSEEvent } from '@/lib/types';

vi.mock('@/lib/sync', () => ({ syncFile: () => {}, syncAll: () => {} }));

const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p2a-watcher-')));
process.env.CTX_ROOT = tmpDir;
process.env.CTX_FRAMEWORK_ROOT = tmpDir;

const AGENT = 'live-agent';
const HB_PATH = path.join(tmpDir, 'state', AGENT, 'heartbeat.json');

let handleFileChange: typeof import('../watcher')['handleFileChange'];
let onSSEEvent: typeof import('../watcher')['onSSEEvent'];
let initWatcher: typeof import('../watcher')['initWatcher'];
let stopWatcher: typeof import('../watcher')['stopWatcher'];

function writeHeartbeat(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    HB_PATH,
    JSON.stringify({
      agent: AGENT,
      org: 'overseer',
      status: 'working',
      current_task: 'WORKING ON: ship P2a',
      last_heartbeat: new Date().toISOString(),
      ...extra,
    }),
  );
}

/** Capture the next SSE event handleFileChange emits (emit is synchronous). */
function captureEvent(run: () => void): SSEEvent | undefined {
  let captured: SSEEvent | undefined;
  const unsubscribe = onSSEEvent((event) => { captured = event; });
  try {
    run();
  } finally {
    unsubscribe();
  }
  return captured;
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fs.mkdirSync(path.join(tmpDir, 'state', AGENT), { recursive: true });

  const configMod = await import('../config');
  expect(configMod.CTX_ROOT).toBe(tmpDir);

  ({ handleFileChange, onSSEEvent, initWatcher, stopWatcher } = await import('../watcher'));
});

afterEach(() => {
  fs.rmSync(HB_PATH, { force: true });
});

describe('watcher heartbeat SSE enrichment (C5 live-update fix)', () => {
  it('emits { agent, health, current_task } on a heartbeat change', () => {
    writeHeartbeat();

    const event = captureEvent(() => handleFileChange(HB_PATH, 'change'));

    expect(event).toBeDefined();
    expect(event!.type).toBe('heartbeat');
    // The payload-shape fix — these fields were absent before C5.
    expect(event!.data.agent).toBe(AGENT);
    expect(event!.data.health).toBe('healthy'); // fresh heartbeat → healthy via real getHealthStatus
    expect(event!.data.current_task).toBe('WORKING ON: ship P2a');
    // Original fields preserved for non-heartbeat consumers.
    expect(event!.data.filePath).toBe(HB_PATH);
    expect(event!.data.changeType).toBe('change');
  });

  it('derives a stale health for an aged heartbeat (grid reflects the tightened threshold live)', () => {
    writeHeartbeat({ last_heartbeat: new Date(Date.now() - 90 * 60_000).toISOString() });

    const event = captureEvent(() => handleFileChange(HB_PATH, 'change'));

    expect(event!.data.agent).toBe(AGENT);
    expect(event!.data.health).toBe('stale');
  });

  it('does not enrich on heartbeat removal (only filePath/changeType travel)', () => {
    const event = captureEvent(() => handleFileChange(HB_PATH, 'remove'));

    expect(event!.type).toBe('heartbeat');
    expect(event!.data.agent).toBeUndefined();
    expect(event!.data.health).toBeUndefined();
    expect(event!.data.changeType).toBe('remove');
  });
});

/**
 * Chokidar-v5 regression guard: drives the REAL watcher end-to-end. Before the
 * fix, getWatchPaths() returned glob patterns (`state/*​/heartbeat.json`) which
 * chokidar v5 silently matches against nothing — so no heartbeat event ever
 * fired and the live-update was dead regardless of the C5 payload enrichment.
 * Watching the `state` directory (recursive) must surface a heartbeat write as
 * an SSE event.
 */
describe('watcher end-to-end (chokidar v5 directory watching)', () => {
  const E2E_AGENT = 'e2e-agent';
  const E2E_STATE_DIR = path.join(tmpDir, 'state', E2E_AGENT);
  const E2E_HB = path.join(E2E_STATE_DIR, 'heartbeat.json');

  beforeAll(() => {
    // Subdir must exist before init so chokidar's recursive scan tracks it.
    fs.mkdirSync(E2E_STATE_DIR, { recursive: true });
  });

  afterAll(() => {
    stopWatcher();
  });

  it('fires a heartbeat SSE event when a heartbeat file is written under the watched state dir', async () => {
    const watcher = initWatcher();
    await new Promise<void>((resolve) => watcher.on('ready', () => resolve()));

    const eventPromise = new Promise<SSEEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no heartbeat SSE event within 12s — chokidar did not fire')),
        12000,
      );
      const unsubscribe = onSSEEvent((event) => {
        if (event.type !== 'heartbeat' || event.data?.agent !== E2E_AGENT) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
    });

    fs.writeFileSync(
      E2E_HB,
      JSON.stringify({
        agent: E2E_AGENT,
        org: 'overseer',
        status: 'working',
        current_task: 'WORKING ON: chokidar v5 fix',
        last_heartbeat: new Date().toISOString(),
      }),
    );

    const event = await eventPromise;
    expect(event.data.agent).toBe(E2E_AGENT);
    expect(event.data.health).toBe('healthy');
    expect(event.data.current_task).toBe('WORKING ON: chokidar v5 fix');
    // vitest's 5s default test timeout would otherwise fire before the 12s
    // chokidar guard above — give the FS-event race headroom under full-suite load.
  }, 15000);
});
