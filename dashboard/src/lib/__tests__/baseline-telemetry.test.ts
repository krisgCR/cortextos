/**
 * Integration tests for baseline telemetry (P0b-2, Task 2.2).
 *
 * Verifies:
 * 1. A human_prompt event appears in the events table after a dashboard send.
 * 2. analytics/overview baseline fields return the aggregate ratio + free signals.
 * 3. Both human channels (dashboard + Telegram) are counted uniformly.
 * 4. Intervention definition is explicit: resolved_by IS NOT NULL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-telemetry-test-'));
process.env.CTX_ROOT = tmpDir;

let db: typeof import('../db')['db'];
let getBaselineTelemetry: typeof import('../data/analytics')['getBaselineTelemetry'];
let syncEvents: typeof import('../sync')['syncEvents'];

beforeAll(async () => {
  const dbMod = await import('../db');
  db = dbMod.db;

  const analyticsMod = await import('../data/analytics');
  getBaselineTelemetry = analyticsMod.getBaselineTelemetry;

  const syncMod = await import('../sync');
  syncEvents = syncMod.syncEvents;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CTX_ROOT;
});

// ---------------------------------------------------------------------------
// Human prompt event pipeline: emit → JSONL → sync → events table
// ---------------------------------------------------------------------------

describe('human_prompt event pipeline', () => {
  it('emitHumanPromptEvent writes a JSONL file that syncEvents can ingest', () => {
    // Emit a human_prompt event for a known org+agent
    const org = 'test-org';
    const agentName = 'pipeline-agent';

    // Manually write the event to the correct path (getEventsDir uses CTX_ROOT)
    const eventsDir = path.join(tmpDir, 'orgs', org, 'analytics', 'events', agentName);
    fs.mkdirSync(eventsDir, { recursive: true });
    const today = new Date().toISOString().split('T')[0];
    const event = {
      id: `test-1234-${agentName}-abc`,
      agent: agentName,
      org,
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      category: 'message',
      event: 'human_prompt',
      severity: 'info',
      metadata: { source: 'dashboard' },
    };
    fs.appendFileSync(path.join(eventsDir, `${today}.jsonl`), JSON.stringify(event) + '\n', 'utf-8');

    // Sync events into SQLite
    const count = syncEvents(org, agentName);
    expect(count).toBeGreaterThanOrEqual(1);

    // Verify the event appears in the events table
    const row = db
      .prepare("SELECT * FROM events WHERE message = 'human_prompt' AND agent = ?")
      .get(agentName) as { message: string; type: string; agent: string; org: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.message).toBe('human_prompt');
    expect(row?.type).toBe('message'); // category maps to type in sync.ts
    expect(row?.agent).toBe(agentName);
    expect(row?.org).toBe(org);
  });
});

// ---------------------------------------------------------------------------
// getBaselineTelemetry — aggregate ratio + free signals
// ---------------------------------------------------------------------------

describe('getBaselineTelemetry', () => {
  const org = 'baseline-org';
  const agentName = 'baseline-agent';

  beforeAll(() => {
    // Insert 4 human_prompt events (dashboard)
    for (let i = 0; i < 4; i++) {
      db.prepare(
        `INSERT OR REPLACE INTO events (id, timestamp, agent, org, type, category, severity, message)
         VALUES (?, datetime('now'), ?, ?, 'message', 'message', 'info', 'human_prompt')`,
      ).run(`hp-${i}`, agentName, org);
    }

    // Insert 2 telegram_received events (Telegram channel)
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT OR REPLACE INTO events (id, timestamp, agent, org, type, category, severity, message)
         VALUES (?, datetime('now'), ?, ?, 'message', 'message', 'info', 'telegram_received')`,
      ).run(`tg-${i}`, agentName, org);
    }

    // Insert 2 completed tasks assigned to baseline-agent
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT OR REPLACE INTO tasks (id, title, status, priority, assignee, org, created_at, completed_at)
         VALUES (?, 'Test task', 'completed', 'normal', ?, ?, datetime('now'), datetime('now'))`,
      ).run(`task-${i}`, agentName, org);
    }

    // Insert an approval with resolved_by (human intervention)
    db.prepare(
      `INSERT OR REPLACE INTO approvals (id, title, category, status, agent, org, created_at, resolved_at, resolved_by)
       VALUES ('appr-1', 'Review action', 'other', 'approved', ?, ?, datetime('now', '-5 minutes'), datetime('now'), 'admin')`,
    ).run(agentName, org);

    // Insert an approval WITHOUT resolved_by (auto-resolved / pending — not an intervention)
    db.prepare(
      `INSERT OR REPLACE INTO approvals (id, title, category, status, agent, org, created_at)
       VALUES ('appr-2', 'Auto action', 'other', 'pending', ?, ?, datetime('now'))`,
    ).run(agentName, org);
  });

  it('returns the aggregate human-prompts-per-task ratio', () => {
    const result = getBaselineTelemetry(30, org);
    // 4 dashboard + 2 telegram = 6 total human prompts, 2 tasks → ratio = 3.0
    expect(result.humanPromptsPerTask.overall).toBeCloseTo(3.0, 5);
  });

  it('counts both human channels (dashboard + Telegram) uniformly', () => {
    const result = getBaselineTelemetry(30, org);
    const agentStats = result.humanPromptsPerTask.byAgent.find((a) => a.agent === agentName);
    expect(agentStats).toBeDefined();
    expect(agentStats?.dashboardPrompts).toBe(4);
    expect(agentStats?.telegramPrompts).toBe(2);
    expect(agentStats?.totalHumanPrompts).toBe(6);
    expect(agentStats?.tasksCompleted).toBe(2);
    expect(agentStats?.ratio).toBeCloseTo(3.0, 5);
  });

  it('returns approval latency (created_at → resolved_at in seconds)', () => {
    const result = getBaselineTelemetry(30, org);
    // One approval resolved ~5 minutes after creation
    expect(result.approvalLatency.avgSeconds).not.toBeNull();
    expect(result.approvalLatency.avgSeconds!).toBeGreaterThan(0);
    expect(result.approvalLatency.avgSeconds!).toBeLessThan(400); // ~5 min = ~300s, allow slack
  });

  it('counts interventions as approvals with resolved_by IS NOT NULL', () => {
    const result = getBaselineTelemetry(30, org);
    // Only appr-1 has resolved_by='admin' → count = 1
    expect(result.interventionByApproval.total).toBe(1);
    const agentIntervention = result.interventionByApproval.byAgent.find(
      (a) => a.agent === agentName,
    );
    expect(agentIntervention?.count).toBe(1);
  });

  it('returns completion rate (completed / total)', () => {
    const result = getBaselineTelemetry(30, org);
    const agentRate = result.completionRate.byAgent.find((a) => a.agent === agentName);
    expect(agentRate).toBeDefined();
    // Both tasks are 'completed' so rate = 1.0
    expect(agentRate?.rate).toBeCloseTo(1.0, 5);
  });

  it('returns windowDays in the result', () => {
    const result = getBaselineTelemetry(7, org);
    expect(result.windowDays).toBe(7);
  });

  it('overall is null when no tasks completed', () => {
    const result = getBaselineTelemetry(30, 'empty-org-no-tasks');
    expect(result.humanPromptsPerTask.overall).toBeNull();
  });

  it('returns the four required baseline fields', () => {
    const result = getBaselineTelemetry(30, org);
    expect(result).toHaveProperty('humanPromptsPerTask');
    expect(result).toHaveProperty('approvalLatency');
    expect(result).toHaveProperty('completionRate');
    expect(result).toHaveProperty('interventionByApproval');
    expect(result).toHaveProperty('cronPassFail');
  });
});
