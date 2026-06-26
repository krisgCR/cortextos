import { Command } from 'commander';
import { IPCClient } from '../daemon/ipc-server.js';
import type { DispatchStatusPayload } from '../types/index.js';

async function setDispatchEnabled(instance: string, enabled: boolean): Promise<void> {
  const ipc = new IPCClient(instance);
  if (!(await ipc.isDaemonRunning())) {
    console.error('Daemon is not running. Start it first: cortextos start');
    process.exit(1);
  }
  const response = await ipc.send({
    type: 'set-dispatch-enabled',
    data: { enabled },
    source: `cortextos dispatch ${enabled ? 'resume' : 'pause'}`,
  });
  if (response.success) {
    console.log(enabled
      ? 'Dispatch RESUMED — new runs will be accepted (subject to budget + concurrency).'
      : 'Dispatch PAUSED — the kill-switch is on; new dispatches are refused (dispatch-disabled).');
    console.log('(In-memory toggle — a daemon restart resets to the launch-time CTX_N4_DISPATCH_ENABLED.)');
  } else {
    console.error(`  Error: ${response.error}`);
    process.exit(1);
  }
}

export const dispatchCommand = new Command('dispatch')
  .description('Control the N4 dispatch kill-switch at runtime (pause/resume/status)');

dispatchCommand
  .command('pause')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Turn the dispatch kill-switch ON — refuse new dispatches without a restart.')
  .action(async (options: { instance: string }) => {
    await setDispatchEnabled(options.instance, false);
  });

dispatchCommand
  .command('resume')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Turn the dispatch kill-switch OFF — allow new dispatches again.')
  .action(async (options: { instance: string }) => {
    await setDispatchEnabled(options.instance, true);
  });

dispatchCommand
  .command('status')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Show whether dispatch is enabled plus the budget/concurrency caps.')
  .action(async (options: { instance: string }) => {
    const ipc = new IPCClient(options.instance);
    if (!(await ipc.isDaemonRunning())) {
      console.error('Daemon is not running. Start it first: cortextos start');
      process.exit(1);
    }
    const response = await ipc.send({ type: 'dispatch-status', source: 'cortextos dispatch status' });
    if (!response.success) {
      console.error(`  Error: ${response.error}`);
      process.exit(1);
    }
    const s = response.data as DispatchStatusPayload;
    console.log(`Dispatch:           ${s.enabled ? 'ENABLED' : 'PAUSED (kill-switch on)'}`);
    console.log(`Team budget tokens: ${s.teamBudgetTokens}`);
    console.log(`Per-team max:       ${s.maxConcurrency}`);
    console.log(`Fleet max:          ${s.fleetMaxConcurrent}`);
  });
