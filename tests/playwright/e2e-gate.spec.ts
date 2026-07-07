/**
 * e2e-gate.spec.ts — the deterministic two-layer E2E gate.
 *
 * Drives a REAL browser (NextAuth login → authenticated session) and exercises
 * the live daemon + dashboard across the dispatch seam:
 *   CLI/UI → IPC → daemon → reserveDispatch → FakeAdapter (zero-bill) → ledger → UI.
 *
 * Assertions are contract-grounded (API responses + on-disk ledger + the
 * kill-switch banner) so the run is reproducible. Open-ended UX bug discovery is
 * the e2e-fleet skill's explore mode, not this gate.
 *
 * On a fully green run, the reporter writes the tree-bound pass-sentinel that the
 * commit/push hooks require. A failing assertion ⇒ no sentinel ⇒ commit blocked.
 */

import { test, expect, request as pwRequest } from '@playwright/test';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  CTX_ROOT,
  bootDaemon,
  bootDashboard,
  disableAllAgents,
  gitCandidate,
  readDashboardCreds,
  setDispatchEnabled,
  billableChildCommands,
  teardown,
  writeSentinelViaCore,
  type RuntimeState,
} from './e2e-gate/harness.js';

// Boot/teardown/sentinel live entirely in this test file's hooks (see config note).
let _state: RuntimeState | null = null;
let failures = 0;
// Positive confirmation that the FINAL test (zero-bill audit) actually ran and
// passed. In serial mode any earlier failure skips it, so this can only be true
// when the whole suite is green — a stronger guard than "no failure counted".
let auditPassed = false;
function S(): RuntimeState {
  if (!_state) throw new Error('e2e-gate: runtime state not booted');
  return _state;
}
function base(): string {
  return S().baseUrl;
}

test.beforeAll(async () => {
  const disabled = disableAllAgents();
  console.log(`[e2e-gate] disabled ${disabled.length} agent(s): ${disabled.join(', ') || '(none)'}`);
  const daemonPid = await bootDaemon();
  console.log(`[e2e-gate] daemon up (pid ${daemonPid})`);
  const { pid: dashboardPid, port } = await bootDashboard();
  console.log(`[e2e-gate] dashboard up on :${port} (pid ${dashboardPid})`);
  const creds = readDashboardCreds();
  const cand = gitCandidate();
  _state = {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    adminUsername: creds.adminUsername,
    adminPassword: creds.adminPassword,
    daemonPid,
    dashboardPid,
    baseSha: cand.baseSha,
    candidateHash: cand.candidateHash,
    files: cand.files,
    billableSpawns: -1,
  };
});

test.afterEach(({}, testInfo) => {
  // test.fail()-annotated tests have expectedStatus='failed'; a matching outcome
  // is NOT a real failure. Only a mismatch (incl. an unexpected pass) counts.
  if (testInfo.status !== testInfo.expectedStatus) failures++;
});

test.afterAll(async () => {
  const { portClosed } = await teardown(_state);
  console.log(`[e2e-gate] teardown complete (port closed: ${portClosed})`);
  // The sentinel is the ONLY honest gate artifact: written iff every test met its
  // expected status AND the zero-bill audit was clean AND teardown proved isolation.
  if (!_state) return;
  if (!auditPassed) return console.log('[e2e-gate] final audit did not confirm green — NO sentinel.');
  if (failures > 0) return console.log(`[e2e-gate] ${failures} failure(s) — NO sentinel.`);
  if (!portClosed) return console.log('[e2e-gate] port not closed — NO sentinel.');
  if (_state.billableSpawns !== 0) return console.log(`[e2e-gate] billable_spawns=${_state.billableSpawns} — NO sentinel.`);
  if (!_state.candidateHash) return console.log('[e2e-gate] no non-trivial change — NO sentinel.');
  const out = writeSentinelViaCore({
    candidateHash: _state.candidateHash,
    baseSha: _state.baseSha,
    files: _state.files,
    billableSpawns: 0,
    ts: new Date().toISOString(),
  });
  console.log(`[e2e-gate] GREEN + zero-bill — pass-sentinel written: ${out}`);
});

interface RunRec {
  run_id: string;
  team_id?: string;
  state: string;
  budget_reserved?: number;
  cancel_reason?: string;
}

function ledgerRuns(): RunRec[] {
  const dir = join(CTX_ROOT, 'state', 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunRec);
}
const LIVE = new Set(['pending', 'dispatching', 'live']);
function liveInTeam(team: string): RunRec[] {
  return ledgerRuns().filter((r) => r.team_id === team && LIVE.has(r.state));
}
async function poll<T>(fn: () => T, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const start = Date.now();
  let v = fn();
  while (!ok(v) && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 250));
    v = fn();
  }
  return v;
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  // Real browser login (NextAuth credentials).
  await page.goto(`${base()}/login`);
  await page.fill('input[name="username"]', S().adminUsername);
  await page.fill('input[name="password"]', S().adminPassword);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 }), page.click('button[type="submit"]')]);
});

test('login lands authenticated (UI, layer 2)', async ({ page }) => {
  expect(new URL(page.url()).pathname).not.toContain('/login');
});

test('dispatch under budget → accepted, run reaches ledger (seam)', async ({ page }) => {
  const team = 'gate-budget';
  const res = await page.request.post(`${base()}/api/dispatch`, {
    data: { name: 'gate-under', dir: CTX_ROOT, prompt: 'noop', team_id: team, budget_tokens: 800_000 },
  });
  const body = (await res.json()) as { data?: { accepted?: boolean } };
  expect(res.status(), JSON.stringify(body)).toBe(200);
  expect(body?.data?.accepted, JSON.stringify(body)).toBe(true);
  // Real seam proof: a RunRecord lands in the on-disk ledger and goes live —
  // CLI/UI → IPC → daemon → reserveDispatch → FakeAdapter → ledger.
  const live = await poll(() => liveInTeam(team), (r) => r.length >= 1, 10_000);
  expect(live.length).toBeGreaterThanOrEqual(1);
});

test('dispatch over budget → refused WITH REASON, no extra live run', async ({ page }) => {
  const team = 'gate-budget';
  const before = liveInTeam(team).length;
  // 800k already reserved (prev test); +400k would exceed the 1M team ceiling.
  const res = await page.request.post(`${base()}/api/dispatch`, {
    data: { name: 'gate-over', dir: CTX_ROOT, prompt: 'noop', team_id: team, budget_tokens: 400_000 },
  });
  const body = (await res.json()) as { data?: { accepted?: boolean; reason?: string } };
  // reserve() is awaited on this path, so the refusal reason IS surfaced
  // (the earlier N4 #1a fire-and-forget concern does not apply to /api/dispatch).
  expect(body?.data?.accepted, JSON.stringify(body)).toBe(false);
  expect(String(body?.data?.reason)).toMatch(/budget|ceiling|cap/i);
  // Refusal writes NO ledger record → live count must not increase.
  await new Promise((r) => setTimeout(r, 1500));
  expect(liveInTeam(team).length).toBe(before);
});

test('cancel-team stops the team\'s live runs (IPC → ledger)', async ({ page }) => {
  const team = 'gate-cancel';
  await page.request.post(`${base()}/api/dispatch`, { data: { name: 'gate-cancel-run', dir: CTX_ROOT, prompt: 'noop', team_id: team, budget_tokens: 100_000 } });
  await poll(() => liveInTeam(team), (r) => r.length >= 1, 10_000);
  const res = await page.request.post(`${base()}/api/teams/${team}/cancel`, { data: {} });
  expect(res.status(), await res.text()).toBe(200);
  const after = await poll(() => liveInTeam(team), (r) => r.length === 0, 10_000);
  expect(after.length).toBe(0);
});

test('cancel-run (human) stops ONE live run WITH REASON (route → IPC → ledger)', async ({ page }) => {
  // The headline "killable" capability: a human stops a single run via the exact
  // route the dashboard "Stop run" button POSTs, and the ledger records reason=human.
  const team = 'gate-cancel-run-human';
  await page.request.post(`${base()}/api/dispatch`, { data: { name: 'gate-stop-run', dir: CTX_ROOT, prompt: 'noop', team_id: team, budget_tokens: 100_000 } });
  const live = await poll(() => liveInTeam(team), (r) => r.length >= 1, 10_000);
  expect(live.length).toBeGreaterThanOrEqual(1);
  const runId = live[0]!.run_id;
  const res = await page.request.post(`${base()}/api/runs/${runId}/cancel`, { data: {} });
  expect(res.status(), await res.text()).toBe(200);
  // Contract: the run leaves the live set AND the ledger carries cancel_reason=human.
  const rec = await poll(
    () => ledgerRuns().find((r) => r.run_id === runId),
    (r) => !!r && !LIVE.has(r.state),
    10_000,
  );
  expect(rec, 'run record missing after cancel').toBeTruthy();
  expect(LIVE.has(rec!.state)).toBe(false);
  expect(rec!.cancel_reason).toBe('human');
});

test('security: unauthenticated dispatch → 401', async () => {
  const anon = await pwRequest.newContext();
  const res = await anon.post(`${base()}/api/dispatch`, { data: { name: 'x', dir: CTX_ROOT, prompt: 'noop' } });
  expect(res.status()).toBe(401);
  await anon.dispose();
});

test('security: cross-origin authenticated dispatch → 403', async ({ page }) => {
  const res = await page.request.post(`${base()}/api/dispatch`, {
    headers: { Origin: 'http://evil.example' },
    data: { name: 'x', dir: CTX_ROOT, prompt: 'noop' },
  });
  expect(res.status()).toBe(403);
});

test('security: malformed run name → 400', async ({ page }) => {
  const res = await page.request.post(`${base()}/api/dispatch`, {
    data: { name: 'Bad Name!!', dir: CTX_ROOT, prompt: 'noop' },
  });
  expect(res.status()).toBe(400);
});

test('kill-switch: pause → banner + disabled dispatch; behavior refuses', async ({ page }) => {
  setDispatchEnabled(false);
  try {
    await page.goto(`${base()}/`);
    // Open the dispatch dialog if a trigger is present, then assert the banner.
    const trigger = page.getByRole('button', { name: /dispatch/i }).first();
    if (await trigger.count()) {
      await trigger.click().catch(() => undefined);
      await expect(page.getByText(/dispatch is currently disabled/i)).toBeVisible({ timeout: 5000 });
    }
    // Behavioral guard (always asserted): a dispatch while paused creates no live run.
    const team = 'gate-killswitch';
    await page.request.post(`${base()}/api/dispatch`, { data: { name: 'ks', dir: CTX_ROOT, prompt: 'noop', team_id: team, budget_tokens: 1000 } });
    await new Promise((r) => setTimeout(r, 1500));
    expect(liveInTeam(team).length).toBe(0);
  } finally {
    setDispatchEnabled(true); // restore
  }
});

test('zero-bill audit: no billable runtime children spawned', async () => {
  const hits = billableChildCommands(S().daemonPid);
  // Record the audit result so afterAll only writes the sentinel when clean.
  S().billableSpawns = hits.length;
  expect(hits, `billable children: ${hits.join(' | ')}`).toEqual([]);
  // Positive confirmation reached ONLY if every prior assertion (incl. this one) passed.
  auditPassed = true;
});
