// Dashboard-side telemetry emit helper.
// Writes human_prompt events to the same JSONL pipeline as the daemon's logEvent:
//   {CTX_ROOT}/orgs/{org}/analytics/events/{agent}/{YYYY-MM-DD}.jsonl
// → picked up by sync.ts syncEvents() → events table → analytics readout.
//
// Non-blocking by design: every caller MUST wrap in try/catch (see emitHumanPromptNonBlocking).
// A logEvent failure must NEVER break the calling user-facing path (Fragile Assumption 5).

import fs from 'fs';
import path from 'path';
import { getAllAgents, getEventsDir } from './config';

function randomId(agentName: string): string {
  const epoch = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${epoch}-${agentName}-${rand}`;
}

export interface HumanPromptEvent {
  id: string;
  agent: string;
  org: string;
  timestamp: string;
  category: 'message';
  event: 'human_prompt';
  severity: 'info';
  metadata: { source: 'dashboard' };
}

/**
 * Write a human_prompt event to the analytics events pipeline.
 * Mirrors the shape of daemon logEvent (src/bus/event.ts:54-63).
 * Throws on any filesystem error — callers must handle (see emitHumanPromptNonBlocking).
 */
export function emitHumanPromptEvent(agent: string): HumanPromptEvent {
  const agents = getAllAgents();
  const agentEntry = agents.find((a) => a.name === agent);
  const org = agentEntry?.org ?? '';

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const event: HumanPromptEvent = {
    id: randomId(agent),
    agent,
    org,
    timestamp,
    category: 'message',
    event: 'human_prompt',
    severity: 'info',
    metadata: { source: 'dashboard' },
  };

  const eventsDir = getEventsDir(org, agent);
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.appendFileSync(path.join(eventsDir, `${today}.jsonl`), JSON.stringify(event) + '\n', 'utf-8');

  return event;
}

/**
 * Non-blocking wrapper — fire-and-forget.
 * Swallows any error so the caller's user-facing path is never broken.
 * Use this in API route handlers (send, etc.).
 */
export function emitHumanPromptNonBlocking(agent: string): void {
  try {
    emitHumanPromptEvent(agent);
  } catch {
    // Intentionally swallowed — telemetry must never break the send path.
  }
}
