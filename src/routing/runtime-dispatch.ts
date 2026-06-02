import type { Platform } from './types.js';

export interface RuntimeClassification {
  platform: Platform;
  reason: string;
  /** Template args for spawning the chosen runtime. {{PROMPT}} is a placeholder slot. */
  spawnArgs: Record<string, string>;
}

// Tasks that benefit from parallel/headless/batch execution → Codex.
const CODEX_RE =
  /\b(batch|parallel|headless|pipeline|transform|aggregate|classify|index|ingest|scan|lint|sweep|mass\s+update|bulk|extract\s+data|data\s+process|etl)\b/i;

/**
 * Classify a task description into a preferred runtime.
 * - Interactive / reasoning tasks → Claude (AgentPTY)
 * - Parallel / headless / batch tasks → Codex
 *
 * The `spawnArgs` shape is the headless contract; `{{PROMPT}}` is a template slot
 * resolved at spawn time. The concrete mechanism is determined by Phase 3 spike.
 */
export function classifyRuntime(task: string): RuntimeClassification {
  const sample = task.slice(0, 500);

  if (CODEX_RE.test(sample)) {
    return {
      platform: 'codex',
      reason: 'task matches headless/batch/parallel pattern',
      spawnArgs: {
        '--sandbox': 'workspace-write',
        '--skip-git-repo-check': 'true',
        prompt: '{{PROMPT}}',
      },
    };
  }

  return {
    platform: 'claude',
    reason: 'interactive reasoning task — default runtime',
    spawnArgs: {},
  };
}
