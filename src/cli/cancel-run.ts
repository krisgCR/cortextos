import { Command } from 'commander';
import { resolveEnv } from '../utils/env.js';
import { IPCClient } from '../daemon/ipc-server.js';

export const cancelRunCommand = new Command('cancel-run')
  .description('Cancel a live dispatch run (human-invoked halt via the guarded cancelRun primitive; reason=human)')
  .argument('<run_id>', 'Run ID to cancel')
  .option('--instance <id>', 'Instance ID', 'default')
  .action(async (runId: string, options: { instance: string }) => {
    const env = resolveEnv({ instanceId: options.instance });
    const client = new IPCClient(env.instanceId);

    const response = await client.send({
      type: 'cancel-run',
      data: { run_id: runId },
    });

    if (response.success) {
      console.log(`Run "${runId}" cancelling (reason=human)`);
      console.log(`Check status: cortextos dispatch status`);
    } else {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }
  });
