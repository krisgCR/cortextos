#!/usr/bin/env node
/**
 * e2e-dirty-nudge.js — PostToolUse(Edit|Write) hook (async, non-blocking).
 *
 * After a non-trivial src/dashboard edit, surfaces a one-line reminder that the
 * E2E gate will require a fresh pass before the next commit/push. Rate-limited to
 * ~once per 30 min so iterative editing is not spammed. Never blocks (exit 0).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const core = require('./lib/e2e-gate-core.js');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(readStdin() || '{}');
  } catch {
    payload = {};
  }

  const filePath = (payload.tool_input && payload.tool_input.file_path) || '';
  const cwd = payload.cwd || process.cwd();
  if (!filePath) process.exit(0);

  const root = core.repoRoot(cwd);
  if (!root) process.exit(0);

  let rel = path.relative(root, filePath);
  if (rel.startsWith('..')) process.exit(0); // outside repo
  rel = rel.split(path.sep).join('/');
  if (!core.isNonTrivial(rel)) process.exit(0);

  // Rate-limit: skip if we nudged in the last 30 minutes.
  const marker = path.join(root, '.planning', 'verify', '.nudge-marker');
  try {
    const st = fs.statSync(marker);
    if (Date.now() - st.mtimeMs < 30 * 60 * 1000) process.exit(0);
  } catch {
    /* no marker yet */
  }
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
  } catch {
    /* best-effort */
  }

  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `note: non-trivial change touched (${rel}). The e2e-gate will require a fresh ` +
        `\`npm run test:e2e-gate\` pass (or the e2e-fleet skill) before the next commit/push.`,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

main();
