#!/usr/bin/env node
/**
 * e2e-commit-gate.js — PreToolUse(Bash) hook.
 *
 * Blocks `git commit` of a non-trivial src/ or dashboard/src/ (etc.) change
 * unless a fresh, honest, tree-bound E2E pass-sentinel exists. The sentinel is
 * emitted ONLY by the deterministic Playwright suite (`npm run test:e2e-gate`),
 * so the model can trigger a run but cannot fake a pass.
 *
 * Bypass: prefix the command with `CTX_E2E_SKIP="reason" git commit ...`
 * (audited to .planning/verify/skips.log).
 *
 * Block = exit 2 + stderr (the Claude Code PreToolUse deny contract). Fail-closed
 * on its own error, but the message always names the CTX_E2E_SKIP escape hatch.
 */

'use strict';

const core = require('./lib/e2e-gate-core.js');

function readStdin() {
  try {
    return require('fs').readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Is `command` a git commit invocation (in any &&/;/| segment)? */
function isGitCommit(command) {
  return String(command)
    .split(/&&|\|\||;|\|/)
    .some((seg) => /(^|\s)git(\s+-C\s+\S+)?\s+commit(\s|$)/.test(seg.trim()));
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(readStdin() || '{}');
  } catch {
    payload = {};
  }

  const command = (payload.tool_input && payload.tool_input.command) || '';
  if (!command || !isGitCommit(command)) {
    process.exit(0); // not our concern
  }

  const cwd = payload.cwd || process.cwd();

  let result;
  try {
    result = core.evaluateGate(cwd, command, process.env);
  } catch (e) {
    process.stderr.write(
      `🔴 e2e-gate: internal error (${e && e.message}). Commit blocked (fail-closed).\n` +
        `   Bypass once with:  CTX_E2E_SKIP="hook error" git commit ...\n`,
    );
    process.exit(2);
  }

  if (result.allow) process.exit(0);

  const files = (result.candidate && result.candidate.files) || [];
  process.stderr.write(
    `🔴 e2e-gate: commit BLOCKED — ${result.reason}.\n` +
      `   ${files.length} non-trivial file(s) changed: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ' …' : ''}\n` +
      `   This repo requires a live two-layer E2E pass (daemon + dashboard in a real browser) before commit.\n` +
      `   → Run the deterministic gate:  npm run test:e2e-gate   (zero-bill, isolated; emits the pass-sentinel)\n` +
      `   → Or use the e2e-fleet skill to drive it + explore the UI.\n` +
      `   → Intentional bypass (audited):  CTX_E2E_SKIP="why" git commit ...\n`,
  );
  process.exit(2);
}

main();
