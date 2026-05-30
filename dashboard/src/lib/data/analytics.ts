// cortextOS Dashboard - Analytics data queries
// Aggregated metrics for charts on the analytics page.

import fs from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { getCTXRoot, getAllAgents } from '@/lib/config';
import type { AgentStat } from '@/components/analytics/agent-effectiveness';

/**
 * Get daily completed task counts for the last N days.
 */
export function getTaskThroughput(
  days: number = 30,
  org?: string,
): Array<{ date: string; tasks: number }> {
  const conditions: string[] = [
    "completed_at >= DATE('now', ?)",
    "status = 'completed'",
  ];
  const params: (string | number)[] = [`-${days} days`];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    return db
      .prepare(
        `SELECT DATE(completed_at) as date, COUNT(*) as tasks
         FROM tasks ${where}
         GROUP BY DATE(completed_at)
         ORDER BY date ASC`,
      )
      .all(...params) as Array<{ date: string; tasks: number }>;
  } catch {
    return [];
  }
}

/**
 * Get per-agent effectiveness stats.
 */
export function getAgentEffectiveness(org?: string): AgentStat[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    // Get all agents with their task stats
    const rows = db
      .prepare(
        `SELECT
           assignee as name,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
         FROM tasks
         ${where ? where + ' AND' : 'WHERE'} assignee IS NOT NULL AND assignee != ''
         GROUP BY assignee`,
      )
      .all(...params) as Array<{
      name: string;
      total: number;
      completed: number;
    }>;

    // Get error counts per agent from events
    const errorRows = db
      .prepare(
        `SELECT agent as name, COUNT(*) as errors
         FROM events
         ${where ? where + ' AND' : 'WHERE'} type = 'error'
         GROUP BY agent`,
      )
      .all(...params) as Array<{ name: string; errors: number }>;

    const errorMap = new Map(errorRows.map((r) => [r.name, r.errors]));

    // Get daily completed tasks for the last 7 days (for sparklines)
    const trendRows = db
      .prepare(
        `SELECT assignee as name, DATE(completed_at) as date, COUNT(*) as count
         FROM tasks
         WHERE completed_at >= DATE('now', '-7 days')
           AND status = 'completed'
           AND assignee IS NOT NULL AND assignee != ''
         GROUP BY assignee, DATE(completed_at)
         ORDER BY date ASC`,
      )
      .all() as Array<{ name: string; date: string; count: number }>;

    // Build trend map: agent -> [7 days of counts]
    const trendMap = new Map<string, number[]>();
    for (const row of trendRows) {
      if (!trendMap.has(row.name)) {
        trendMap.set(row.name, new Array(7).fill(0));
      }
      // Figure out which index (0-6) this date falls into
      const dayDiff = Math.floor(
        (Date.now() - new Date(row.date).getTime()) / (86400 * 1000),
      );
      const idx = 6 - Math.min(dayDiff, 6);
      const arr = trendMap.get(row.name)!;
      arr[idx] = row.count;
    }

    return rows.map((row) => ({
      name: row.name,
      completionRate: row.total > 0 ? (row.completed / row.total) * 100 : 0,
      errorCount: errorMap.get(row.name) ?? 0,
      tasksCompleted: row.completed,
      recentTrend: trendMap.get(row.name) ?? [0, 0, 0, 0, 0, 0, 0],
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Baseline telemetry — P0b-2
// ---------------------------------------------------------------------------

export interface AgentBaselineStats {
  agent: string;
  dashboardPrompts: number;
  telegramPrompts: number;
  totalHumanPrompts: number;
  tasksCompleted: number;
  ratio: number | null;
}

export interface BaselineTelemetry {
  windowDays: number;
  humanPromptsPerTask: {
    overall: number | null;
    byAgent: AgentBaselineStats[];
  };
  // Approval latency: time from approval request creation to resolution (seconds).
  approvalLatency: {
    avgSeconds: number | null;
    byAgent: Array<{ agent: string; avgSeconds: number | null }>;
  };
  completionRate: {
    overall: number | null;
    byAgent: Array<{ agent: string; rate: number | null }>;
  };
  // Intervention: approval requests manually resolved by a human (resolved_by IS NOT NULL).
  // A non-null resolved_by means a human explicitly approved or rejected the request,
  // as opposed to an automated timeout/skip. Counts both approved and rejected.
  interventionByApproval: {
    total: number;
    byAgent: Array<{ agent: string; count: number }>;
  };
  // Cron pass/fail: per-agent summary of cron executions in the last 24 hours.
  cronPassFail: {
    byAgent: Array<{
      agent: string;
      firesLast24h: number;
      failedLast24h: number;
      successRate: number | null;
    }>;
  };
}

// Cron execution log entries — same shape as health/route.ts
interface CronExecEntry {
  ts: string;
  status: 'fired' | 'retried' | 'failed';
}

const CRONS_STATE_DIR = '.cortextOS/state/agents';

function readCronStats(agentName: string): { firesLast24h: number; failedLast24h: number } {
  try {
    const logPath = path.join(getCTXRoot(), CRONS_STATE_DIR, agentName, 'cron-execution.log');
    if (!fs.existsSync(logPath)) return { firesLast24h: 0, failedLast24h: 0 };
    const raw = fs.readFileSync(logPath, 'utf-8');
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let fires = 0;
    let failed = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as CronExecEntry;
        if (new Date(entry.ts).getTime() < cutoff) continue;
        fires++;
        if (entry.status === 'failed') failed++;
      } catch { /* skip malformed */ }
    }
    return { firesLast24h: fires, failedLast24h: failed };
  } catch {
    return { firesLast24h: 0, failedLast24h: 0 };
  }
}

/**
 * Aggregate baseline telemetry for the analytics overview.
 * Counts human prompts (dashboard + Telegram), tasks completed, approval latency,
 * intervention rate, and cron pass/fail — all derivable without schema changes.
 */
export function getBaselineTelemetry(days: number = 30, org?: string): BaselineTelemetry {
  const windowParam = `-${days} days`;
  const orgCondition = org ? 'AND org = ?' : '';
  const orgParams: (string | number)[] = org ? [org] : [];

  // --- Human prompts per agent ---
  // dashboard: category='message', event='human_prompt' (from Tap 1)
  // Telegram: category='message', event='telegram_received' (reused, D-P0b2-5)
  let promptRows: Array<{
    agent: string;
    dashboard_prompts: number;
    telegram_prompts: number;
  }> = [];
  try {
    promptRows = db
      .prepare(
        `SELECT
           agent,
           SUM(CASE WHEN message = 'human_prompt' THEN 1 ELSE 0 END) AS dashboard_prompts,
           SUM(CASE WHEN message = 'telegram_received' THEN 1 ELSE 0 END) AS telegram_prompts
         FROM events
         WHERE type = 'message'
           AND message IN ('human_prompt', 'telegram_received')
           AND timestamp >= datetime('now', ?)
           ${orgCondition}
         GROUP BY agent`,
      )
      .all(windowParam, ...orgParams) as typeof promptRows;
  } catch { /* leave empty */ }

  // --- Tasks completed per agent ---
  let taskRows: Array<{ agent: string; completed: number }> = [];
  try {
    taskRows = db
      .prepare(
        `SELECT assignee AS agent, COUNT(*) AS completed
         FROM tasks
         WHERE status = 'completed'
           AND completed_at >= datetime('now', ?)
           AND assignee IS NOT NULL AND assignee != ''
           ${orgCondition}
         GROUP BY assignee`,
      )
      .all(windowParam, ...orgParams) as typeof taskRows;
  } catch { /* leave empty */ }

  const taskMap = new Map(taskRows.map((r) => [r.agent, r.completed]));
  const allAgents = new Set([
    ...promptRows.map((r) => r.agent),
    ...taskRows.map((r) => r.agent),
  ]);

  const byAgent: AgentBaselineStats[] = [];
  let totalPrompts = 0;
  let totalTasks = 0;
  for (const agent of allAgents) {
    const row = promptRows.find((r) => r.agent === agent);
    const dashboardPrompts = row?.dashboard_prompts ?? 0;
    const telegramPrompts = row?.telegram_prompts ?? 0;
    const total = dashboardPrompts + telegramPrompts;
    const tasksCompleted = taskMap.get(agent) ?? 0;
    totalPrompts += total;
    totalTasks += tasksCompleted;
    byAgent.push({
      agent,
      dashboardPrompts,
      telegramPrompts,
      totalHumanPrompts: total,
      tasksCompleted,
      ratio: tasksCompleted > 0 ? total / tasksCompleted : null,
    });
  }
  byAgent.sort((a, b) => a.agent.localeCompare(b.agent));

  // --- Approval latency ---
  let latencyRows: Array<{ agent: string; avg_seconds: number | null }> = [];
  try {
    latencyRows = db
      .prepare(
        `SELECT
           agent,
           AVG((julianday(resolved_at) - julianday(created_at)) * 86400) AS avg_seconds
         FROM approvals
         WHERE resolved_at IS NOT NULL
           AND created_at >= datetime('now', ?)
           ${orgCondition}
         GROUP BY agent`,
      )
      .all(windowParam, ...orgParams) as typeof latencyRows;
  } catch { /* leave empty */ }

  const latencyAll = latencyRows.filter((r) => r.avg_seconds !== null);
  const overallAvgLatency =
    latencyAll.length > 0
      ? latencyAll.reduce((s, r) => s + (r.avg_seconds ?? 0), 0) / latencyAll.length
      : null;

  // --- Completion rate ---
  let completionRows: Array<{ agent: string; total: number; completed: number }> = [];
  try {
    completionRows = db
      .prepare(
        `SELECT
           assignee AS agent,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
         FROM tasks
         WHERE completed_at >= datetime('now', ?)
           AND assignee IS NOT NULL AND assignee != ''
           ${orgCondition}
         GROUP BY assignee`,
      )
      .all(windowParam, ...orgParams) as typeof completionRows;
  } catch { /* leave empty */ }

  const totalAllTasks = completionRows.reduce((s, r) => s + r.total, 0);
  const totalCompleted = completionRows.reduce((s, r) => s + r.completed, 0);
  const overallCompletionRate =
    totalAllTasks > 0 ? totalCompleted / totalAllTasks : null;

  // --- Intervention by approval ---
  let interventionRows: Array<{ agent: string; count: number }> = [];
  try {
    interventionRows = db
      .prepare(
        `SELECT agent, COUNT(*) AS count
         FROM approvals
         WHERE resolved_by IS NOT NULL
           AND created_at >= datetime('now', ?)
           ${orgCondition}
         GROUP BY agent`,
      )
      .all(windowParam, ...orgParams) as typeof interventionRows;
  } catch { /* leave empty */ }

  // --- Cron pass/fail (filesystem reads, best-effort) ---
  const cronByAgent = getAllAgents()
    .filter((a) => !org || a.org === org)
    .map((a) => {
      const { firesLast24h, failedLast24h } = readCronStats(a.name);
      return {
        agent: a.name,
        firesLast24h,
        failedLast24h,
        successRate: firesLast24h > 0 ? (firesLast24h - failedLast24h) / firesLast24h : null,
      };
    })
    .filter((r) => r.firesLast24h > 0); // omit agents with no recent cron activity

  return {
    windowDays: days,
    humanPromptsPerTask: {
      overall: totalTasks > 0 ? totalPrompts / totalTasks : null,
      byAgent,
    },
    approvalLatency: {
      avgSeconds: overallAvgLatency,
      byAgent: latencyRows.map((r) => ({ agent: r.agent, avgSeconds: r.avg_seconds })),
    },
    completionRate: {
      overall: overallCompletionRate,
      byAgent: completionRows.map((r) => ({
        agent: r.agent,
        rate: r.total > 0 ? r.completed / r.total : null,
      })),
    },
    interventionByApproval: {
      total: interventionRows.reduce((s, r) => s + r.count, 0),
      byAgent: interventionRows,
    },
    cronPassFail: { byAgent: cronByAgent },
  };
}
