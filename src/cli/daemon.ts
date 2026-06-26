import { Command } from 'commander';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { execSync, spawn, spawnSync } from 'child_process';
import { IPCClient } from '../daemon/ipc-server.js';

const IS_WINDOWS = platform() === 'win32';
const SAFE_CMD = /^[@a-z0-9._/-]+$/i;
const PM2_DAEMON_NAME = 'cortextos-daemon';

function commandExists(cmd: string): boolean {
  if (!SAFE_CMD.test(cmd)) return false;
  const which = IS_WINDOWS ? 'where' : 'which';
  const result = spawnSync(which, [cmd], { stdio: 'pipe' });
  return result.status === 0;
}

function ctxRootFor(instance: string): string {
  return join(homedir(), '.cortextos', instance);
}

/** Read the daemon PID from {ctxRoot}/daemon.pid (written by src/daemon/index.ts). */
function readDaemonPid(instance: string): number | null {
  const pidFile = join(ctxRootFor(instance), 'daemon.pid');
  if (!existsSync(pidFile)) return null;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** True if the process is alive (signal 0 probes without killing). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True if PM2 is installed AND it manages a cortextos-daemon process. */
function isPm2ManagedDaemon(): boolean {
  if (!commandExists('pm2')) return false;
  const result = spawnSync('pm2', ['describe', PM2_DAEMON_NAME], { stdio: 'pipe' });
  return result.status === 0;
}

async function waitForDaemonStop(ipc: IPCClient, pid: number | null, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = await ipc.isDaemonRunning();
    const aliveByPid = pid != null ? pidAlive(pid) : false;
    if (!running && !aliveByPid) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function stopDaemon(instance: string): Promise<boolean> {
  const ipc = new IPCClient(instance);
  const running = await ipc.isDaemonRunning();
  const pid = readDaemonPid(instance);

  if (!running && (pid == null || !pidAlive(pid))) {
    console.log('Daemon is not running.');
    // Clean up a stale pidfile if one was left behind.
    if (pid != null) {
      try { unlinkSync(join(ctxRootFor(instance), 'daemon.pid')); } catch { /* ignore */ }
    }
    return true;
  }

  // PM2-managed path — let PM2 own the lifecycle so it doesn't auto-restart.
  if (isPm2ManagedDaemon()) {
    console.log(`Stopping daemon via PM2 (${PM2_DAEMON_NAME})...`);
    try {
      execSync(`pm2 stop ${PM2_DAEMON_NAME}`, { stdio: 'inherit' });
      console.log('Daemon stopped.');
      return true;
    } catch {
      console.error(`PM2 stop failed. Try: pm2 stop ${PM2_DAEMON_NAME}`);
      return false;
    }
  }

  // Detached path — SIGTERM the PID from the pidfile. The daemon's shutdown
  // handler (src/daemon/index.ts) gracefully stops agents, closes the IPC
  // socket, and removes the pidfile on SIGTERM.
  if (pid == null) {
    console.error('Daemon appears to be running but no daemon.pid was found.');
    console.error('Find it manually:  pgrep -f dist/daemon.js');
    return false;
  }

  console.log(`Stopping daemon (pid ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.error(`Failed to signal pid ${pid}: ${String(err)}`);
    return false;
  }

  const stopped = await waitForDaemonStop(ipc, pid);
  if (stopped) {
    console.log('Daemon stopped.');
    return true;
  }
  console.error(`Daemon (pid ${pid}) did not stop within 10s. Force-kill with:  kill -9 ${pid}`);
  return false;
}

/** Spawn `cortextos start` as a child so the full start path (billing guard,
 *  PM2 vs detached, spawn-with-retry) is reused without duplication. */
function spawnStart(instance: string, extraArgs: string[]): number {
  const cliJs = join(process.cwd(), 'dist', 'cli.js');
  if (!existsSync(cliJs)) {
    console.error('Daemon not built. Run: npm run build');
    return 1;
  }
  const result = spawnSync(process.execPath, [cliJs, 'start', '--instance', instance, ...extraArgs], {
    stdio: 'inherit',
  });
  return result.status ?? 0;
}

export const daemonCommand = new Command('daemon')
  .description('Manage the cortextOS daemon process itself (start/stop/restart/status)');

daemonCommand
  .command('start')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--foreground', 'Run daemon in foreground (no PM2, for debugging)')
  .option('--allow-api-key', 'Permit starting with ANTHROPIC_API_KEY set (forces metered billing)')
  .description('Start the daemon (delegates to `cortextos start`)')
  .action((options: { instance: string; foreground?: boolean; allowApiKey?: boolean }) => {
    const extra: string[] = [];
    if (options.foreground) extra.push('--foreground');
    if (options.allowApiKey) extra.push('--allow-api-key');
    process.exit(spawnStart(options.instance, extra));
  });

daemonCommand
  .command('stop')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Stop the daemon process (PM2 or detached). Stops all agents too.')
  .action(async (options: { instance: string }) => {
    const ok = await stopDaemon(options.instance);
    process.exit(ok ? 0 : 1);
  });

daemonCommand
  .command('restart')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--allow-api-key', 'Permit restarting with ANTHROPIC_API_KEY set (forces metered billing)')
  .description('Restart the daemon process (PM2 or detached).')
  .action(async (options: { instance: string; allowApiKey?: boolean }) => {
    // PM2 owns restart semantics directly — cleanest path.
    if (isPm2ManagedDaemon()) {
      console.log(`Restarting daemon via PM2 (${PM2_DAEMON_NAME})...`);
      try {
        execSync(`pm2 restart ${PM2_DAEMON_NAME}`, { stdio: 'inherit' });
        console.log('Daemon restarted.');
        process.exit(0);
      } catch {
        console.error(`PM2 restart failed. Try: pm2 restart ${PM2_DAEMON_NAME}`);
        process.exit(1);
      }
    }

    // Detached path — stop, then re-spawn via `cortextos start`.
    const stopped = await stopDaemon(options.instance);
    if (!stopped) {
      console.error('Restart aborted — daemon did not stop cleanly.');
      process.exit(1);
    }
    const extra: string[] = [];
    if (options.allowApiKey) extra.push('--allow-api-key');
    process.exit(spawnStart(options.instance, extra));
  });

daemonCommand
  .command('status')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Show whether the daemon process is running.')
  .action(async (options: { instance: string }) => {
    const ipc = new IPCClient(options.instance);
    const running = await ipc.isDaemonRunning();
    const pid = readDaemonPid(options.instance);
    const managed = isPm2ManagedDaemon();

    if (running) {
      const via = managed ? 'PM2-managed' : pid != null ? `detached (pid ${pid})` : 'running';
      console.log(`Daemon is running — ${via}.`);
      console.log('Agent health:  cortextos status');
    } else {
      console.log('Daemon is not running.');
      console.log('Start it with:  cortextos start');
    }
  });
