#!/usr/bin/env node
/**
 * e2e-prepush-gate.js — PreToolUse(Bash) hook.
 *
 * The real "code leaves the machine" boundary: blocks `git push` when a
 * non-trivial change in the push range (`<pushBase>..HEAD`, pushBase = `@{u}` →
 * origin/<branch> → origin/main) lacks a fresh, content-matching E2E pass. This
 * catches commits that bypassed the commit gate (e.g. via CTX_E2E_SKIP) before
 * they reach the remote — the commit gate alone cannot, since its check is gone
 * by push time.
 *
 * Shares the content-fingerprint core with the commit gate (so one pass covers
 * stage → commit → push); same CTX_E2E_SKIP escape hatch.
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

function isGitPush(command) {
  return String(command)
    .split(/&&|\|\||;|\|/)
    .some((seg) => /(^|\s)git(\s+-C\s+\S+)?\s+push(\s|$)/.test(seg.trim()));
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(readStdin() || '{}');
  } catch {
    payload = {};
  }

  const command = (payload.tool_input && payload.tool_input.command) || '';
  if (!command || !isGitPush(command)) process.exit(0);

  const cwd = payload.cwd || process.cwd();

  let result;
  try {
    result = core.evaluateGate(cwd, command, process.env, 'push');
  } catch (e) {
    process.stderr.write(
      `🔴 e2e-gate: internal error (${e && e.message}). Push blocked (fail-closed).\n` +
        `   Bypass once with:  CTX_E2E_SKIP="hook error" git push ...\n`,
    );
    process.exit(2);
  }

  if (result.allow) process.exit(0);

  const files = (result.candidate && result.candidate.files) || [];
  process.stderr.write(
    `🔴 e2e-gate: push BLOCKED — ${result.reason}.\n` +
      `   ${files.length} non-trivial file(s) in the push range lack a fresh E2E pass: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ' …' : ''}\n` +
      `   → Run:  npm run test:e2e-gate   (or the e2e-fleet skill), then push.\n` +
      `   → Intentional bypass (audited):  CTX_E2E_SKIP="why" git push ...\n`,
  );
  process.exit(2);
}

main();
