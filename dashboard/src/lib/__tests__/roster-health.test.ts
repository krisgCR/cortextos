/**
 * P2a contract: passive health computation across the full 5-agent overseer
 * roster after the threshold tightening (no regression at fleet scale).
 *
 * Each roster member carries an explicit static model + runtime in config.json
 * and a heartbeat of a known age; discoverAgents() must compute the right
 * healthy/stale/down disposition from that age and surface the model/runtime.
 * The codex reviewer (no heartbeat) must read `down`, proving the absence path.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Pin both roots at a temp dir BEFORE config.ts evaluates (it captures CTX_ROOT
// / CTX_FRAMEWORK_ROOT at import time). Same dir for both keeps getAgentDir,
// getHeartbeatPath and the org scan consistent and fully isolated from the repo.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2a-roster-'));
process.env.CTX_ROOT = tmpDir;
process.env.CTX_FRAMEWORK_ROOT = tmpDir;

let discoverAgents: typeof import('../data/agents')['discoverAgents'];

const ORG = 'overseer';

interface RosterMember {
  name: string;
  model: string;
  runtime: string;
  /** undefined → no heartbeat file written (absence → down). */
  heartbeatAgeMin?: number;
  expectedHealth: 'healthy' | 'stale' | 'down';
}

const ROSTER: RosterMember[] = [
  { name: 'orchestrator', model: 'opus', runtime: 'claude-code', heartbeatAgeMin: 5, expectedHealth: 'healthy' },
  { name: 'implementer-1', model: 'sonnet', runtime: 'claude-code', heartbeatAgeMin: 90, expectedHealth: 'stale' },
  { name: 'implementer-2', model: 'sonnet', runtime: 'claude-code', heartbeatAgeMin: 10, expectedHealth: 'healthy' },
  { name: 'researcher', model: 'haiku', runtime: 'claude-code', heartbeatAgeMin: 300, expectedHealth: 'down' },
  { name: 'reviewer', model: 'gpt-5-codex', runtime: 'codex-app-server', expectedHealth: 'down' },
];

function writeRosterMember(m: RosterMember): void {
  const agentDir = path.join(tmpDir, 'orgs', ORG, 'agents', m.name);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'config.json'),
    JSON.stringify({ agent_name: m.name, enabled: true, runtime: m.runtime, model: m.model }, null, 2),
  );

  if (m.heartbeatAgeMin !== undefined) {
    const stateDir = path.join(tmpDir, 'state', m.name);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'heartbeat.json'),
      JSON.stringify({
        agent: m.name,
        org: ORG,
        status: 'idle',
        last_heartbeat: new Date(Date.now() - m.heartbeatAgeMin * 60_000).toISOString(),
      }),
    );
  }
}

beforeAll(async () => {
  for (const m of ROSTER) writeRosterMember(m);

  const configMod = await import('../config');
  expect(configMod.CTX_ROOT).toBe(tmpDir);

  ({ discoverAgents } = await import('../data/agents'));
});

describe('discoverAgents — overseer 5-agent roster passive health', () => {
  it('discovers all 5 roster members', async () => {
    const summaries = await discoverAgents(ORG);
    expect(summaries.map((s) => (s as unknown as { systemName: string }).systemName).sort())
      .toEqual(['implementer-1', 'implementer-2', 'orchestrator', 'researcher', 'reviewer']);
  });

  it('computes the correct health, model and runtime for each member from heartbeat age', async () => {
    const summaries = await discoverAgents(ORG);
    const byName = new Map(
      summaries.map((s) => [(s as unknown as { systemName: string }).systemName, s]),
    );

    for (const m of ROSTER) {
      const summary = byName.get(m.name);
      expect(summary, `missing roster member ${m.name}`).toBeDefined();
      expect(summary!.health, `health for ${m.name}`).toBe(m.expectedHealth);
      expect(summary!.model, `model for ${m.name}`).toBe(m.model);
      expect(summary!.runtime, `runtime for ${m.name}`).toBe(m.runtime);
    }
  });
});
