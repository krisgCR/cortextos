/**
 * N4 Phase A.1 contract: watcher recognizes state/runs/*.json and state/teams/*.json paths.
 *
 * Also tests that the runtime enrichment repair works (runtime events now get the
 * parsed record attached to data). Torn-read defense is verified with invalid JSON.
 * Follows the pattern from watcher-runtimes.test.ts.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SSEEvent } from '@/lib/types';

vi.mock('@/lib/sync', () => ({ syncFile: () => {}, syncAll: () => {} }));

const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'n4-watcher-')));
process.env.CTX_ROOT = tmpDir;
process.env.CTX_FRAMEWORK_ROOT = tmpDir;

const RUN_PATH = path.join(tmpDir, 'state', 'runs', 'run-n4-001.json');
const TEAM_PATH = path.join(tmpDir, 'state', 'teams', 'team-alpha.json');
const RUNTIME_PATH = path.join(tmpDir, 'state', 'runtimes', 'run-abc.json');

let handleFileChange: typeof import('../watcher')['handleFileChange'];
let onSSEEvent: typeof import('../watcher')['onSSEEvent'];

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
  vi.spyOn(console, 'error').mockImplementation(() => {});

  fs.mkdirSync(path.join(tmpDir, 'state', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'state', 'teams'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'state', 'runtimes'), { recursive: true });

  ({ handleFileChange, onSSEEvent } = await import('../watcher'));
});

describe('watcher run path recognition', () => {
  it('isRelevantPath: state/runs/*.json fires an SSE event', () => {
    fs.writeFileSync(RUN_PATH, JSON.stringify({ run_id: 'run-n4-001', state: 'live' }));

    const event = captureEvent(() => handleFileChange(RUN_PATH, 'add'));

    expect(event).toBeDefined();
    expect(event!.data.filePath).toBe(RUN_PATH);
  });

  it('categorizeFilePath: state/runs/*.json maps to "run" SSE type', () => {
    const event = captureEvent(() => handleFileChange(RUN_PATH, 'change'));

    expect(event!.type).toBe('run');
  });

  it('enriches run events with parsed record fields', () => {
    fs.writeFileSync(
      RUN_PATH,
      JSON.stringify({ run_id: 'run-n4-001', state: 'live', team_id: 'team-alpha', budget_reserved: 100 }),
    );

    const event = captureEvent(() => handleFileChange(RUN_PATH, 'change'));

    expect(event!.type).toBe('run');
    // filePath and changeType are always present
    expect(event!.data.filePath).toBe(RUN_PATH);
    expect(event!.data.changeType).toBe('change');
    // parsed record fields are merged in
    expect(event!.data.run_id).toBe('run-n4-001');
    expect(event!.data.state).toBe('live');
    expect(event!.data.team_id).toBe('team-alpha');
    expect(event!.data.budget_reserved).toBe(100);
  });
});

describe('watcher team path recognition', () => {
  it('isRelevantPath: state/teams/*.json fires an SSE event', () => {
    fs.writeFileSync(TEAM_PATH, JSON.stringify({ team_id: 'team-alpha', cancel_generation: 2 }));

    const event = captureEvent(() => handleFileChange(TEAM_PATH, 'add'));

    expect(event).toBeDefined();
    expect(event!.data.filePath).toBe(TEAM_PATH);
  });

  it('categorizeFilePath: state/teams/*.json maps to "team" SSE type', () => {
    const event = captureEvent(() => handleFileChange(TEAM_PATH, 'change'));

    expect(event!.type).toBe('team');
  });

  it('enriches team events with parsed record fields', () => {
    fs.writeFileSync(
      TEAM_PATH,
      JSON.stringify({ team_id: 'team-alpha', cancel_generation: 5, last_cancel_at: '2026-06-25T00:00:00Z' }),
    );

    const event = captureEvent(() => handleFileChange(TEAM_PATH, 'change'));

    expect(event!.data.team_id).toBe('team-alpha');
    expect(event!.data.cancel_generation).toBe(5);
    expect(event!.data.last_cancel_at).toBe('2026-06-25T00:00:00Z');
  });
});

describe('runtime enrichment repair (N3 live-update fix)', () => {
  it('enriches runtime events with parsed record fields', () => {
    fs.writeFileSync(
      RUNTIME_PATH,
      JSON.stringify({ run_id: 'run-abc', runtime: 'claude-bg', state: 'working' }),
    );

    const event = captureEvent(() => handleFileChange(RUNTIME_PATH, 'change'));

    expect(event!.type).toBe('runtime');
    expect(event!.data.filePath).toBe(RUNTIME_PATH);
    expect(event!.data.run_id).toBe('run-abc');
    expect(event!.data.state).toBe('working');
  });
});

describe('torn-read defense', () => {
  it('does NOT throw on invalid JSON — emits base event without record fields', () => {
    const tornPath = path.join(tmpDir, 'state', 'runs', 'run-torn.json');
    fs.writeFileSync(tornPath, '{invalid json');

    let event: SSEEvent | undefined;
    expect(() => {
      event = captureEvent(() => handleFileChange(tornPath, 'add'));
    }).not.toThrow();

    // Base fields are always present
    expect(event).toBeDefined();
    expect(event!.data.filePath).toBe(tornPath);
    expect(event!.data.changeType).toBe('add');
    // run_id should NOT be present (parse failed)
    expect(event!.data.run_id).toBeUndefined();
  });

  it('enriches correctly after torn-read recovers with valid JSON', () => {
    const recoverPath = path.join(tmpDir, 'state', 'runs', 'run-recover.json');
    // Write valid JSON — simulates recovery after torn read
    fs.writeFileSync(recoverPath, JSON.stringify({ run_id: 'run-recover', state: 'pending' }));

    const event = captureEvent(() => handleFileChange(recoverPath, 'add'));

    expect(event!.data.run_id).toBe('run-recover');
    expect(event!.data.state).toBe('pending');
  });
});

describe('regression guard: existing event types still work', () => {
  it('heartbeat paths still categorize as "heartbeat"', () => {
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

  it('runtime paths still categorize as "runtime"', () => {
    const event = captureEvent(() => handleFileChange(RUNTIME_PATH, 'change'));

    expect(event!.type).toBe('runtime');
  });
});
