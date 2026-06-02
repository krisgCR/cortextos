/**
 * P2a §1.1 contract: `cortextos add-agent <name> --model <m>`.
 *
 * Two invariants this pins:
 *  1. The `--model` value is persisted into config.json for EVERY runtime,
 *     including the default claude-code runtime. The bug guarded here (Codex
 *     review C3) is that the model merge must NOT be coupled to the
 *     `runtime !== 'claude-code'` block — doing so silently skipped the entire
 *     claude roster (Orchestrator / Implementer×2 / Researcher).
 *  2. The `{{model}}` template placeholder (present in templates/hermes/config.json)
 *     is substituted by copyTemplateFiles — to the supplied model when --model is
 *     given, and to an empty string (never a leftover literal `{{model}}`) when it
 *     is omitted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { addAgentCommand } from '../../../src/cli/add-agent';

describe('add-agent --model', () => {
  let tempRoot: string;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalCwd: string | undefined;
  let originalFrameworkRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'p2a-model-rt-'));
    tempHome = mkdtempSync(join(tmpdir(), 'p2a-model-home-'));

    originalHome = process.env.HOME;
    originalCwd = process.env.CTX_PROJECT_ROOT;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    process.env.HOME = tempHome;
    process.env.CTX_FRAMEWORK_ROOT = tempRoot;
    process.env.CTX_PROJECT_ROOT = tempRoot;

    // Symlink the real templates dir so findTemplateDir resolves.
    const realTemplates = join(__dirname, '..', '..', '..', 'templates');
    symlinkSync(realTemplates, join(tempRoot, 'templates'), 'dir');

    mkdirSync(join(tempRoot, 'orgs', 'testorg', 'agents'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'orgs', 'testorg', 'context.json'),
      JSON.stringify({ name: 'testorg', timezone: 'America/New_York' }),
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.CTX_PROJECT_ROOT = originalCwd;
    process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('persists --model into config.json for a claude-code agent (C3: not skipped by the runtime block)', async () => {
    await addAgentCommand.parseAsync([
      'node', 'cli', 'model-claude', '--model', 'haiku',
      '--org', 'testorg', '--instance', 'p2a-test',
    ]);

    const cfgPath = join(tempRoot, 'orgs', 'testorg', 'agents', 'model-claude', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));

    // The C3 regression case: claude-code is the DEFAULT runtime and must still
    // receive the model field — the merge is independent of the runtime block.
    expect(cfg.runtime).toBe('claude-code');
    expect(cfg.model).toBe('haiku');
  });

  it('persists --model for a non-default (codex-app-server) runtime too', async () => {
    await addAgentCommand.parseAsync([
      'node', 'cli', 'model-codex', '--model', 'gpt-5-codex',
      '--runtime', 'codex-app-server',
      '--org', 'testorg', '--instance', 'p2a-test',
    ]);

    const cfgPath = join(tempRoot, 'orgs', 'testorg', 'agents', 'model-codex', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.runtime).toBe('codex-app-server');
    expect(cfg.model).toBe('gpt-5-codex');
  });

  it('substitutes the {{model}} template placeholder when --model is provided', async () => {
    // templates/hermes/config.json carries `"model": "{{model}}"`.
    await addAgentCommand.parseAsync([
      'node', 'cli', 'model-hermes', '--model', 'sonnet',
      '--template', 'hermes', '--runtime', 'hermes',
      '--org', 'testorg', '--instance', 'p2a-test',
    ]);

    const cfgPath = join(tempRoot, 'orgs', 'testorg', 'agents', 'model-hermes', 'config.json');
    const raw = readFileSync(cfgPath, 'utf-8');

    // No leftover placeholder, and the value resolved to the supplied model.
    expect(raw).not.toContain('{{model}}');
    expect(JSON.parse(raw).model).toBe('sonnet');
  });

  it('replaces {{model}} with an empty string (never a leftover literal) when --model is omitted', async () => {
    await addAgentCommand.parseAsync([
      'node', 'cli', 'model-hermes-blank',
      '--template', 'hermes', '--runtime', 'hermes',
      '--org', 'testorg', '--instance', 'p2a-test',
    ]);

    const cfgPath = join(tempRoot, 'orgs', 'testorg', 'agents', 'model-hermes-blank', 'config.json');
    const raw = readFileSync(cfgPath, 'utf-8');

    // The placeholder was substituted (to '') — it must not survive verbatim.
    expect(raw).not.toContain('{{model}}');
    expect(JSON.parse(raw).model).toBe('');
  });
});
