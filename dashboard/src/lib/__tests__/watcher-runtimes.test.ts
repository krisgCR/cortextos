/**
 * N3 Phase 2 contract: watcher recognizes state/runtimes/*.json paths.
 *
 * isRelevantPath must pass runtime boundary record files through to handleFileChange;
 * categorizeFilePath must label them as 'runtime' so the SSE subscriber knows to
 * update the runtime federation view. Both functions are exercised directly — no
 * chokidar dependency — following the same pattern as watcher-heartbeat-sse.test.ts.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SSEEvent } from '@/lib/types';

vi.mock('@/lib/sync', () => ({ syncFile: () => {}, syncAll: () => {} }));

const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'n3-watcher-')));
process.env.CTX_ROOT = tmpDir;
process.env.CTX_FRAMEWORK_ROOT = tmpDir;

const RUNTIME_PATH = path.join(tmpDir, 'state', 'runtimes', 'run-abc123.json');

let handleFileChange: typeof import('../watcher')['handleFileChange'];
let onSSEEvent: typeof import('../watcher')['onSSEEvent'];

/** Capture the next SSE event handleFileChange emits (synchronous). */
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
  fs.mkdirSync(path.join(tmpDir, 'state', 'runtimes'), { recursive: true });

  const configMod = await import('../config');
  expect(configMod.CTX_ROOT).toBe(tmpDir);

  ({ handleFileChange, onSSEEvent } = await import('../watcher'));
});

describe('watcher runtime path recognition', () => {
  it('isRelevantPath: state/runtimes/*.json returns true via handleFileChange firing', () => {
    // Write a minimal runtime file so syncFile (mocked) does not error on read
    fs.writeFileSync(RUNTIME_PATH, JSON.stringify({ run_id: 'run-abc123' }));

    const event = captureEvent(() => handleFileChange(RUNTIME_PATH, 'add'));

    // If isRelevantPath returned false the handler would return early without emitting
    expect(event).toBeDefined();
    expect(event!.data.filePath).toBe(RUNTIME_PATH);
  });

  it('categorizeFilePath: state/runtimes/*.json maps to "runtime" SSE type', () => {
    const event = captureEvent(() => handleFileChange(RUNTIME_PATH, 'change'));

    expect(event!.type).toBe('runtime');
  });

  it('heartbeat paths still categorize as "heartbeat" (regression guard)', () => {
    const hbPath = path.join(tmpDir, 'state', 'some-agent', 'heartbeat.json');
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(
      hbPath,
      JSON.stringify({
        agent: 'some-agent',
        org: 'overseer',
        status: 'idle',
        last_heartbeat: new Date().toISOString(),
      }),
    );

    const event = captureEvent(() => handleFileChange(hbPath, 'change'));

    expect(event!.type).toBe('heartbeat');
  });

  it('task paths still categorize as "task" (regression guard)', () => {
    const taskPath = path.join(tmpDir, 'orgs', 'overseer', 'tasks', 't-1.json');
    fs.mkdirSync(path.dirname(taskPath), { recursive: true });
    fs.writeFileSync(taskPath, JSON.stringify({ id: 't-1', title: 'Test' }));

    const event = captureEvent(() => handleFileChange(taskPath, 'change'));

    expect(event!.type).toBe('task');
  });
});
