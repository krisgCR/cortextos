/**
 * harness.ts — isolated, zero-bill boot/teardown for the E2E gate.
 *
 * Boots a throwaway cortextOS daemon + dashboard for instance `e2e-gate` with:
 *   - every repo agent disabled (no auto-boot billed sessions)
 *   - CTX_E2E_FAKE_RUNTIME=1 (all dispatch lanes → zero-bill FakeAdapter)
 *   - ANTHROPIC_API_KEY scrubbed (no metered routing)
 * Tracks process groups for whole-tree teardown and a baseline child snapshot
 * for the zero-bill process-spawn audit.
 *
 * The runtime state (port, creds, pids, git candidate) is persisted to
 * .planning/verify/.e2e-runtime.json so the spec, teardown, and reporter share it.
 */

import { spawn, execFileSync } from 'child_process';
import { createServer } from 'net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const INSTANCE = 'e2e-gate';
export const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
export const CTX_ROOT = join(homedir(), '.cortextos', INSTANCE);
/** The gate's single source of truth, invoked as a subprocess (no ESM/CJS interop). */
export const CORE_LIB = join(REPO_ROOT, '.claude', 'hooks', 'lib', 'e2e-gate-core.js');
const LOG_DIR = join(REPO_ROOT, '.planning', 'verify', '.e2e-logs');

export interface RuntimeState {
  port: number;
  baseUrl: string;
  adminUsername: string;
  adminPassword: string;
  daemonPid: number;
  dashboardPid: number;
  baseSha: string;
  candidateHash: string;
  files: string[];
  billableSpawns: number; // set to 0 by the audit test on success
}

/** Pick an OS-assigned free TCP port (bind 0, then release). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(label: string, fn: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`harness: timed out waiting for ${label} (${timeoutMs}ms)`);
}

/** Enumerate all descendant PIDs of `rootPid` (inclusive) via the process table. */
export function descendantPids(rootPid: number): number[] {
  let out: string;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [rootPid];
  }
  const children = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  const result: number[] = [];
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop()!;
    result.push(p);
    for (const c of children.get(p) ?? []) stack.push(c);
  }
  return result;
}

/** Process-spawn audit: any descendant whose args name a billed runtime binary. */
export function billableChildCommands(rootPid: number): string[] {
  const pids = new Set(descendantPids(rootPid));
  let out: string;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const args = m[2];
    if (!pids.has(pid)) continue;
    // A billed runtime = a `claude`/`codex` CLI child. Exclude our own node/test procs.
    if (/(^|\/)(claude|codex)(\s|$)/.test(args) || /\bclaude\s+agents\b/.test(args) || /\bcodex\s+(exec|app-server)\b/.test(args)) {
      hits.push(`${pid}: ${args.slice(0, 120)}`);
    }
  }
  return hits;
}

function spawnDetached(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }): number {
  mkdirSync(LOG_DIR, { recursive: true });
  const fd = openSync(opts.logFile, 'a');
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true, // own process group → whole-tree kill via -pgid
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  if (!child.pid) throw new Error(`harness: failed to spawn ${cmd}`);
  return child.pid;
}

/** Disable every repo agent for the instance, before any boot. */
export function disableAllAgents(): string[] {
  const agentsGlob = join(REPO_ROOT, 'orgs');
  const names: { name: string; org: string }[] = [];
  try {
    for (const org of readdirSync(agentsGlob)) {
      const agentsDir = join(agentsGlob, org, 'agents');
      if (!existsSync(agentsDir)) continue;
      for (const name of readdirSync(agentsDir)) names.push({ name, org });
    }
  } catch {
    /* no orgs dir → nothing to disable */
  }
  const map: Record<string, { enabled: boolean; org: string }> = {};
  for (const { name, org } of names) map[name] = { enabled: false, org };
  const cfgDir = join(CTX_ROOT, 'config');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'enabled-agents.json'), JSON.stringify(map, null, 2));
  return names.map((n) => n.name);
}

/** Scrubbed, zero-bill env for daemon + dashboard children. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // never metered
  env.CTX_E2E_FAKE_RUNTIME = '1'; // all lanes → FakeAdapter
  env.CTX_N4_DISPATCH_ENABLED = 'true'; // dispatch ON so we can exercise the seam
  return env;
}

export async function bootDaemon(): Promise<number> {
  const cli = join(REPO_ROOT, 'dist', 'cli.js');
  const pid = spawnDetached('node', [cli, 'start', '--instance', INSTANCE, '--foreground'], {
    cwd: REPO_ROOT,
    env: baseEnv(),
    logFile: join(LOG_DIR, 'daemon.log'),
  });
  await waitFor('daemon socket', () => existsSync(join(CTX_ROOT, 'daemon.sock')), 30_000);
  return pid;
}

/** Detect an early port-bind conflict from the dashboard log within `windowMs`.
 *  Closes the freePort() TOCTOU race: if the OS-assigned port was grabbed between
 *  release and bind, the child logs EADDRINUSE and we retry with a fresh port. */
async function portConflicted(logFile: string, port: number, windowMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    let log = '';
    try {
      log = readFileSync(logFile, 'utf8');
    } catch {
      /* log not created yet */
    }
    if (/EADDRINUSE|address already in use/i.test(log)) return true;
    if (pidsOnPort(port).length > 0) return false; // bound successfully → proceed
    await sleep(300);
  }
  return false; // no conflict observed (likely still compiling) → proceed
}

/** Boot the dashboard on an OS-assigned free port, retrying on a bind collision.
 *  Owns port selection so a lost freePort() race is recoverable. */
export async function bootDashboard(): Promise<{ pid: number; port: number }> {
  const cli = join(REPO_ROOT, 'dist', 'cli.js');
  const logFile = join(LOG_DIR, 'dashboard.log');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = await freePort();
    const pid = spawnDetached(
      'node',
      [cli, 'dashboard', '--instance', INSTANCE, '--hostname', '127.0.0.1', '--port', String(port)],
      { cwd: REPO_ROOT, env: baseEnv(), logFile },
    );
    if (await portConflicted(logFile, port, 6_000)) {
      killPids([pid], 'SIGKILL');
      continue; // port stolen between release and bind — pick another
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(
      'dashboard http 200',
      async () => {
        const res = await fetch(`${baseUrl}/login`).catch(() => null);
        return !!res && res.status === 200;
      },
      180_000, // webpack cold compile of ~40 routes can be slow
    );
    return { pid, port };
  }
  throw new Error('harness: dashboard failed to bind a free port after 3 attempts');
}

/** Read the instance's auto-generated dashboard credentials. */
export function readDashboardCreds(): { adminUsername: string; adminPassword: string } {
  const envFile = join(CTX_ROOT, 'dashboard.env');
  const txt = readFileSync(envFile, 'utf8');
  const get = (k: string): string => {
    const m = txt.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  return { adminUsername: get('ADMIN_USERNAME') || 'admin', adminPassword: get('ADMIN_PASSWORD') };
}

/** Toggle the daemon kill-switch via the supported CLI (IPC set-dispatch-enabled). */
export function setDispatchEnabled(enabled: boolean): void {
  const cli = join(REPO_ROOT, 'dist', 'cli.js');
  execFileSync('node', [cli, 'dispatch', enabled ? 'resume' : 'pause', '--instance', INSTANCE], {
    cwd: REPO_ROOT,
    env: baseEnv(),
    encoding: 'utf8',
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** PIDs currently listening on a TCP port (the `next dev` server reparents away
 *  from the tracked pid, so the port is the reliable handle). */
function pidsOnPort(port: number): number[] {
  try {
    return execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' })
      .split('\n')
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/** PIDs whose command line names this instance or its dashboard port (scoped — never blanket). */
function scopedPids(port: number): number[] {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .filter((m) => m[2].includes(`--instance ${INSTANCE}`) || m[2].includes(`--port ${port}`) || m[2].includes(`:${port} `))
      .map((m) => Number(m[1]));
  } catch {
    return [];
  }
}

function killPids(pids: Iterable<number>, signal: NodeJS.Signals): void {
  for (const p of pids) {
    try {
      process.kill(p, signal);
    } catch {
      /* already gone */
    }
    try {
      process.kill(-p, signal); // also the group, best-effort
    } catch {
      /* no group / gone */
    }
  }
}

export async function teardown(state: RuntimeState | null): Promise<{ portClosed: boolean }> {
  // Clean daemon shutdown first (releases the socket/ledger gracefully).
  try {
    const cli = join(REPO_ROOT, 'dist', 'cli.js');
    execFileSync('node', [cli, 'daemon', 'stop', '--instance', INSTANCE], { cwd: REPO_ROOT, env: baseEnv(), timeout: 15_000 });
  } catch {
    /* best-effort */
  }
  if (state) {
    const targets = (): Set<number> =>
      new Set<number>([
        ...descendantPids(state.dashboardPid),
        ...descendantPids(state.daemonPid),
        ...pidsOnPort(state.port),
        ...scopedPids(state.port),
      ]);
    killPids(targets(), 'SIGTERM');
    await sleep(1500);
    killPids(targets(), 'SIGKILL'); // escalate any survivors
  }
  // Verify the dashboard port is actually closed (retry — the dev server can
  // take a moment to release the socket).
  let portClosed = true;
  if (state) {
    portClosed = false;
    for (let i = 0; i < 10; i++) {
      if (pidsOnPort(state.port).length === 0) {
        portClosed = true;
        break;
      }
      killPids(pidsOnPort(state.port), 'SIGKILL');
      await sleep(500);
    }
  }
  // Wipe the throwaway instance state.
  try {
    rmSync(CTX_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  return { portClosed };
}

/** Compute the git candidate (baseSha + non-trivial-bound hash) via the gate core CLI. */
export function gitCandidate(): { baseSha: string; candidateHash: string; files: string[] } {
  // Reuse the single source of truth (subprocess) so the sentinel binds exactly
  // what the commit/push hooks check.
  const out = execFileSync('node', [CORE_LIB, 'candidate', 'git commit'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const cand = JSON.parse(out) as { error?: string; baseSha?: string; candidateHash?: string; files?: string[] };
  if (cand.error) return { baseSha: 'unknown', candidateHash: '', files: [] };
  return { baseSha: cand.baseSha ?? 'unknown', candidateHash: cand.candidateHash ?? '', files: cand.files ?? [] };
}

/** Write the pass-sentinel via the gate core CLI (subprocess). */
export function writeSentinelViaCore(fields: Record<string, unknown>): string {
  const out = execFileSync('node', [CORE_LIB, 'write', JSON.stringify({ cwd: REPO_ROOT, ...fields })], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out.trim();
}
