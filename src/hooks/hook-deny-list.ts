/**
 * hook-deny-list.ts — PreToolUse deny-list guard.
 *
 * Fail-closed: any error/unparseable/empty input → block.
 * ALLOW = process.exit(0) silent (no output).
 * BLOCK = emit {decision:'block',reason} to stdout + process.exit(0).
 *
 * Covers: Bash, Read, Write, Edit, MultiEdit, NotebookEdit.
 *
 * Write-fence: scoped to CTX_AGENT_DIR (the agent's own directory),
 * realpath-resolved. Only enforced when CTX_AGENT_DIR is set — a missing
 * env var does not turn every write into a block (would break non-agent use).
 *
 * D3 residual limit: an externally SIGKILL'd hook process exits via the
 * runHook wrapper with status??0 → allow. Documented accepted limit; not
 * re-architected here.
 */

import { realpathSync } from 'fs';
import { dirname, basename, join } from 'path';
import { homedir } from 'os';
import { readStdin } from './index.js';
import { isPathUnderRoots, SYSTEM_BLOCKLIST } from '../utils/allowed-roots.js';

const MAX_INPUT_BYTES = 1_048_576; // 1 MiB — oversized input → fail-closed

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

function block(reason: string): never {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

function resolveFilePath(rawPath: string): string {
  const home = homedir();
  const expanded = rawPath
    .replace(/^~(?=\/|$)/, home)
    .replace(/^\$HOME(?=\/|$)/, home);
  try {
    return realpathSync(expanded).replace(/\\/g, '/');
  } catch {
    // File doesn't exist yet — resolve through parent dir to follow symlinks
    // (e.g. /tmp → /private/tmp on macOS) so the fence comparison is consistent.
    try {
      const parentResolved = realpathSync(dirname(expanded));
      return join(parentResolved, basename(expanded)).replace(/\\/g, '/');
    } catch {
      return expanded.replace(/\\/g, '/');
    }
  }
}

// ---------------------------------------------------------------------------
// Secret-path detection (for Read tool and Bash cat-like reads)
// ---------------------------------------------------------------------------

const SECRET_PATH_PREFIXES = (() => {
  const h = homedir().replace(/\\/g, '/');
  return [`${h}/.ssh`, `${h}/.aws`, `${h}/.gnupg`];
})();

const SECRET_EXACT_NAMES = new Set(['.netrc', '.credentials', '.credentials.json']);
const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'];

function isSecretPath(resolvedPath: string): boolean {
  for (const prefix of SECRET_PATH_PREFIXES) {
    if (resolvedPath === prefix || resolvedPath.startsWith(prefix + '/')) return true;
  }
  const base = resolvedPath.split('/').pop() ?? '';
  if (SECRET_EXACT_NAMES.has(base)) return true;
  for (const ext of SECRET_EXTENSIONS) {
    if (resolvedPath.endsWith(ext)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// System-blocklist check (belt-and-suspenders for write tools)
// ---------------------------------------------------------------------------

function isSystemBlocked(normalizedPath: string): boolean {
  for (const blocked of SYSTEM_BLOCKLIST) {
    const nb = blocked.replace(/\\/g, '/');
    // Exact match always applies.
    if (normalizedPath === nb) return true;
    // Prefix match only for non-root entries — '/' as a prefix matches every
    // absolute path, which would block all writes. Skip it for prefix checks.
    if (nb !== '/' && normalizedPath.startsWith(nb.endsWith('/') ? nb : nb + '/')) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Bash command checks
// ---------------------------------------------------------------------------

// rm that carries both recursive AND force flags (combined or split).
// Matches: rm -rf, rm -fr, rm -r -f, rm -f -r, rm --recursive --force, etc.
// Two patterns cover: (1) combined flags in one token, (2) split across separate tokens.
const RM_RECURSIVE_RE = /\brm\b[^|&;\n]*(?:-[a-zA-Z]*[rR]|-[rR]\b|--recursive\b)/;
const RM_FORCE_RE = /\brm\b[^|&;\n]*(?:-[a-zA-Z]*[fF]|-[fF]\b|--force\b)/;

// Targets that make rm -rf destructive at scale.
const DANGEROUS_RM_TARGET_RE =
  /\brm\b[^|&;\n]*(?:~(?:\/|$)|\$HOME(?:\/|$)|\/(?:\s|$|\*)|\/home\b|\/root\b|\/usr\b|\/etc\b|\/var\b|\/boot\b|\/dev\b|\/sys\b|\/proc\b)/;

// Secret reads via common shell reading commands.
// Includes tilde, $HOME, and absolute home path so injected absolute paths don't bypass.
const _h = homedir().replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECRET_SHELL_READ_RE = new RegExp(
  `\\b(?:cat|less|head|tail|more|bat|view|type)\\b[^\\n|;&]*(?:${_h}/\\.ssh|${_h}/\\.aws|${_h}/\\.gnupg|~/\\.ssh|~/\\.aws|~/\\.gnupg|\\$HOME/\\.ssh|\\$HOME/\\.aws|\\$HOME/\\.gnupg|\\.credentials(?:\\.json)?(?:\\s|$)|\\.pem(?:\\s|$)|\\.key(?:\\s|$))`,
);

// Pipe-to-shell: "... | bash", "... | sh", "curl ... | bash", etc.
const PIPE_TO_SHELL_RE = /\|\s*(?:ba)?sh\b/;

function checkBash(command: string): void {
  if (RM_RECURSIVE_RE.test(command) && RM_FORCE_RE.test(command) && DANGEROUS_RM_TARGET_RE.test(command)) {
    block('Blocked: rm -rf on broad/home/root path');
  }

  if (SECRET_SHELL_READ_RE.test(command)) {
    block('Blocked: shell command reading secret/credential file');
  }

  if (PIPE_TO_SHELL_RE.test(command)) {
    block('Blocked: pipe-to-shell execution (e.g. curl|bash, wget|sh)');
  }
}

// ---------------------------------------------------------------------------
// Read tool check
// ---------------------------------------------------------------------------

function checkRead(filePath: string): void {
  const resolved = resolveFilePath(filePath);
  if (isSecretPath(resolved)) {
    block(`Blocked: Read of secret/credential path: ${filePath}`);
  }
}

// ---------------------------------------------------------------------------
// Write-fence check (Write, Edit, MultiEdit, NotebookEdit)
// ---------------------------------------------------------------------------

function checkWriteFence(toolName: string, filePath: string): void {
  const resolved = resolveFilePath(filePath);

  // Always block system-level paths regardless of agent dir.
  if (isSystemBlocked(resolved)) {
    block(`Blocked: ${toolName} targets system-blocklisted path: ${filePath}`);
  }

  // Agent-dir fence: only enforced when CTX_AGENT_DIR is known.
  const rawAgentDir = process.env.CTX_AGENT_DIR;
  if (rawAgentDir) {
    let agentDir: string;
    try {
      agentDir = realpathSync(rawAgentDir).replace(/\\/g, '/');
    } catch {
      agentDir = rawAgentDir.replace(/\\/g, '/');
    }
    if (!isPathUnderRoots(resolved, [agentDir])) {
      block(
        `Blocked: ${toolName} outside agent's own directory (CTX_AGENT_DIR fence): ${filePath}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Outer catch: any uncaught exception fails closed.
  try {
    const rawInput = await readStdin();

    // Empty or missing input → fail-closed.
    if (!rawInput || !rawInput.trim()) {
      block('Blocked: empty hook input (fail-closed)');
    }

    // Oversized input → fail-closed.
    if (rawInput.length > MAX_INPUT_BYTES) {
      block('Blocked: oversized hook input (fail-closed)');
    }

    // Parse explicitly. Do NOT delegate to parseHookInput — it swallows JSON
    // errors and returns {tool_name:'unknown'} masking a real parse failure.
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(rawInput);
    } catch {
      block('Blocked: JSON parse error in hook input (fail-closed)');
    }

    if (
      !parsedRaw ||
      typeof parsedRaw !== 'object' ||
      Array.isArray(parsedRaw)
    ) {
      block('Blocked: malformed hook payload (fail-closed)');
    }

    const payload = parsedRaw as Record<string, unknown>;

    if (typeof payload.tool_name !== 'string' || !payload.tool_name) {
      block('Blocked: missing or invalid tool_name in hook input (fail-closed)');
    }

    const toolName = payload.tool_name as string;
    const toolInput: Record<string, unknown> =
      typeof payload.tool_input === 'object' &&
      payload.tool_input !== null &&
      !Array.isArray(payload.tool_input)
        ? (payload.tool_input as Record<string, unknown>)
        : {};

    switch (toolName) {
      // Bash (Claude) + shell execution tools (Codex app-server runtime)
      case 'Bash':
      case 'local_shell':
      case 'shell':
      case 'shell_command':
      case 'exec_command': {
        const command = String(toolInput.command ?? '');
        if (command) checkBash(command);
        break;
      }

      // Claude read tool
      case 'Read': {
        const filePath = String(toolInput.file_path ?? '');
        if (filePath) checkRead(filePath);
        break;
      }

      // File-mutation tools: Claude (Write/Edit/MultiEdit/NotebookEdit) + Codex (apply_patch)
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit':
      case 'apply_patch': {
        const filePath = String(toolInput.file_path ?? '');
        if (filePath) checkWriteFence(toolName, filePath);
        break;
      }

      // All other tools pass through silently.
    }

    // Allow: silent exit.
    process.exit(0);
  } catch {
    // Fail closed on any uncaught exception.
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: 'Blocked: unexpected error in deny-guard (fail-closed)',
      }) + '\n',
    );
    process.exit(0);
  }
}

main();
