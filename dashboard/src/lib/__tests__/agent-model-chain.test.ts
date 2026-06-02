/**
 * P2a Phase 2 contract: the per-agent `model` field flows end-to-end through
 * the dashboard chain that the Codex review (C4) flagged as fragile —
 *
 *   config.json
 *     → discoverAgents()            (data/agents.ts: AgentSummary.model)
 *     → AgentsPage map              (page.tsx: AgentCardData.model — the layer
 *                                    the original plan missed)
 *     → AgentCard render            (agent-card.tsx: the model badge)
 *
 * If ANY link drops `model`, the badge renders blank. The three tests below pin
 * each link: the data read, the page-level map forwarding, and the card render.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Isolate from the repo: pin both roots at a temp dir before config.ts loads.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2a-chain-'));
process.env.CTX_ROOT = tmpDir;
process.env.CTX_FRAMEWORK_ROOT = tmpDir;

// AgentCard pulls in next + a heavy action menu; stub the parts irrelevant to
// the model-badge contract so renderToStaticMarkup stays deterministic.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('next/link', () => ({ default: (props: { children?: unknown }) => props.children }));
vi.mock('@/components/agents/agent-actions', () => ({ AgentActions: () => null }));

let discoverAgents: typeof import('../data/agents')['discoverAgents'];
let AgentsPage: typeof import('../../app/(dashboard)/agents/page')['default'];
let AgentCard: typeof import('../../components/agents/agent-card')['AgentCard'];
type AgentCardData = import('../../components/agents/agent-card').AgentCardData;

const ORG = 'overseer';
const AGENT = 'devbot';
const MODEL = 'opus';

function writeAgent(): void {
  const agentDir = path.join(tmpDir, 'orgs', ORG, 'agents', AGENT);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'config.json'),
    JSON.stringify({ agent_name: AGENT, enabled: true, runtime: 'claude-code', model: MODEL }, null, 2),
  );
  const stateDir = path.join(tmpDir, 'state', AGENT);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'heartbeat.json'),
    JSON.stringify({ agent: AGENT, org: ORG, status: 'idle', last_heartbeat: new Date().toISOString() }),
  );
}

// Recursively locate the `initialAgents` prop AgentsPage hands to AgentsGrid.
function findInitialAgents(node: unknown): AgentCardData[] | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findInitialAgents(child);
      if (found) return found;
    }
    return null;
  }
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props && Array.isArray(props.initialAgents)) return props.initialAgents as AgentCardData[];
  return props ? findInitialAgents(props.children) : null;
}

beforeAll(async () => {
  writeAgent();

  const configMod = await import('../config');
  expect(configMod.CTX_ROOT).toBe(tmpDir);

  ({ discoverAgents } = await import('../data/agents'));
  ({ default: AgentsPage } = await import('../../app/(dashboard)/agents/page'));
  ({ AgentCard } = await import('../../components/agents/agent-card'));
});

describe('per-agent model — dashboard chain (C4)', () => {
  it('data layer: discoverAgents() returns the model from config.json', async () => {
    const summaries = await discoverAgents(ORG);
    const devbot = summaries.find(
      (s) => (s as unknown as { systemName: string }).systemName === AGENT,
    );
    expect(devbot, 'devbot not discovered').toBeDefined();
    expect(devbot!.model).toBe(MODEL);
  });

  it('page-map layer: AgentsPage forwards model into the AgentCardData it passes to the grid', async () => {
    const element = await AgentsPage({ searchParams: Promise.resolve({ org: ORG }) });
    const initialAgents = findInitialAgents(element);

    expect(initialAgents, 'AgentsGrid initialAgents prop not found').toBeTruthy();
    const card = initialAgents!.find((a) => a.systemName === AGENT);
    expect(card, 'devbot card not mapped').toBeDefined();
    expect(card!.model).toBe(MODEL);
  });

  it('render layer: AgentCard renders the model badge when present, and omits it when absent', () => {
    const base: AgentCardData = {
      name: AGENT,
      systemName: AGENT,
      org: ORG,
      emoji: '',
      role: 'implementer',
      health: 'healthy',
      tasksToday: 0,
      runtime: 'claude-code',
    };

    const withModel = renderToStaticMarkup(createElement(AgentCard, { agent: { ...base, model: MODEL } }));
    expect(withModel).toContain(MODEL);

    const withoutModel = renderToStaticMarkup(createElement(AgentCard, { agent: base }));
    expect(withoutModel).not.toContain(MODEL);
  });
});
