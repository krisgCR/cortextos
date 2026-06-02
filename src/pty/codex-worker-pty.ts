import { spawn, type ChildProcess } from 'child_process';
import { createWriteStream, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Codex one-shot headless worker.
 * Runs `codex exec -s workspace-write --skip-git-repo-check "<prompt>"` as a child process.
 * Matches the minimal interface WorkerProcess needs from AgentPTY.
 *
 * Spike-validated: exits cleanly with code 0 on completion (2026-06-01).
 * Mechanism: Candidate A (`codex exec`). See Task 3.1 in WORK.md.
 */
export class CodexWorkerPty {
  private proc: ChildProcess | null = null;
  private _pid: number | undefined;
  private onExitHandler: ((code: number) => void) | null = null;

  constructor(
    private readonly logPath: string,
    private readonly workDir: string,
  ) {}

  onExit(cb: (code: number) => void): void {
    this.onExitHandler = cb;
  }

  async spawn(_mode: string, prompt: string): Promise<void> {
    mkdirSync(dirname(this.logPath), { recursive: true });
    const logStream = createWriteStream(this.logPath, { flags: 'a' });

    this.proc = spawn(
      'codex',
      ['exec', '-s', 'workspace-write', '--skip-git-repo-check', prompt],
      { cwd: this.workDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    this._pid = this.proc.pid;
    this.proc.stdout?.pipe(logStream);
    this.proc.stderr?.pipe(logStream);

    this.proc.on('close', (code) => {
      logStream.end();
      if (this.onExitHandler) this.onExitHandler(code ?? 1);
      this.proc = null;
    });
  }

  getPid(): number | undefined {
    return this._pid;
  }

  write(_data: string): void {
    // One-shot process — injections are not supported; silently dropped.
  }

  kill(): void {
    this.proc?.kill('SIGTERM');
  }
}
