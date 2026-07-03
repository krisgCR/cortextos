/**
 * e2e-gate-core.js — single source of truth for the cortextOS E2E commit/push gate.
 *
 * Used by BOTH:
 *   - the PreToolUse hooks (e2e-commit-gate.js / e2e-prepush-gate.js) — to CHECK
 *     whether a non-trivial change has a fresh, honest pass-sentinel.
 *   - the Playwright e2e-gate teardown — to WRITE the sentinel on green
 *     (invoked via this file's CLI: `node e2e-gate-core.js write ...`).
 *
 * Design (see .planning/wild-twirling-mccarthy plan):
 *   - The sentinel is emitted by the deterministic test runner, never hand-written,
 *     and is BOUND to the CONTENT of the non-trivial files (a hash of their git
 *     blob shas), NOT to a diff-vs-base. Content-binding makes one pass valid across
 *     the whole stage → commit → push lifecycle (the committed/pushed blob equals
 *     the worktree blob the suite tested), while still re-blocking on any drift.
 *   - Two gate modes share this core: the commit gate fingerprints what WOULD be
 *     committed (worktree content); the push gate fingerprints what WOULD leave the
 *     machine (content at HEAD across `@{u}..HEAD`). Same content ⇒ same hash ⇒ the
 *     same pass satisfies both.
 *   - Threat model = the model's own forgetfulness/laziness, NOT a malicious actor.
 *     "Ungameable enough" = the honest path is one command, and a stale/fake pass
 *     fails the content-hash/process-audit checks.
 *
 * Plain CommonJS, node built-ins only (no deps, no build step).
 */

'use strict';

const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Non-trivial filter — broadened (false-negatives are worse than false-positives)
// ---------------------------------------------------------------------------

/**
 * A change is "non-trivial" (gate-relevant) if it can alter daemon or dashboard
 * BEHAVIOR. Excludes tests, type decls, docs, and the gitignored planning dir.
 * @param {string} f repo-relative POSIX path
 * @returns {boolean}
 */
function isNonTrivial(f) {
  // Hard excludes first.
  if (f.endsWith('.d.ts')) return false;
  if (f.endsWith('.test.ts') || f.endsWith('.spec.ts')) return false;
  if (f.endsWith('.md')) return false;
  if (f.startsWith('tests/')) return false;
  if (f.startsWith('.planning/')) return false;

  // Behavior-affecting includes.
  if (f.startsWith('src/') && f.endsWith('.ts')) return true;
  if (f.startsWith('dashboard/src/')) return true;
  if (f.startsWith('dashboard/next.config.')) return true;
  if (f.startsWith('dashboard/middleware.')) return true;
  if (f === 'dashboard/package.json' || f === 'dashboard/package-lock.json') return true;
  if (f === 'package.json' || f === 'package-lock.json') return true;
  if (f.startsWith('bus/')) return true;
  if (f.startsWith('templates/')) return true;
  if (f.startsWith('.claude/hooks/')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Git helpers (no shell — execFileSync with arg arrays)
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function repoRoot(cwd) {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function errMsg(e) {
  return e && e.message ? e.message : String(e);
}

/** Sentinel marker for a file that is absent (deleted / not present). Unified
 *  across modes so a deletion fingerprints identically whether seen in the
 *  worktree (commit mode) or at HEAD (push mode). */
const ABSENT = 'ABSENT';

/** git blob sha of a file's WORKTREE content (the bytes the E2E suite ran). */
function blobInWorktree(root, file) {
  try {
    return git(root, ['hash-object', '--', file]);
  } catch {
    return ABSENT;
  }
}

/** git blob sha of a file's content AT HEAD. */
function blobAtHead(root, file) {
  try {
    return git(root, ['rev-parse', `HEAD:${file}`]);
  } catch {
    return ABSENT;
  }
}

/** First verifiable push base: tracked upstream, else origin/<branch>, else
 *  origin/main|master. null when none resolves (e.g. no remote configured). */
function pushBase(root) {
  const refs = ['@{u}'];
  try {
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch && branch !== 'HEAD') refs.push(`origin/${branch}`);
  } catch {
    /* detached HEAD — fall through to shared refs */
  }
  refs.push('origin/main', 'origin/master');
  for (const ref of refs) {
    try {
      git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch {
      /* not resolvable — try next */
    }
  }
  return null;
}

/** Content fingerprint of a sorted file set: sha256 over `path\0<blobSha>` lines. */
function contentHash(files, blobOf) {
  const sig = files.map((f) => `${f}\0${blobOf(f)}`).join('\n');
  return sha256(`sig:${sig}`);
}

// ---------------------------------------------------------------------------
// Candidate-commit content
// ---------------------------------------------------------------------------

/**
 * Compute a CONTENT-bound candidate fingerprint for what `gitCommand` would
 * publish, in one of two modes:
 *
 *   - 'commit' (default): the non-trivial files that WOULD be committed,
 *     fingerprinted by their WORKTREE content (what the E2E suite ran against).
 *       · plain `git commit`        → staged files (`git diff --cached`)
 *       · `git commit -a/-am/--all` → staged + unstaged-tracked files
 *       · `git commit --amend`      → handled identically; the resulting commit's
 *         content is fingerprinted at push time, so reword-only amends (empty
 *         non-trivial set) are allowed and content amends are re-checked on push.
 *   - 'push': the non-trivial files that differ across `<pushBase>..HEAD` — the
 *     commits actually leaving the machine — fingerprinted by their content AT
 *     HEAD. This is the real "code leaves the box" boundary (a prior commit that
 *     bypassed the commit gate is caught here).
 *
 * The fingerprint is a hash of {path → git-blob-sha} over the non-trivial files
 * only — NOT a diff-vs-base. Because the committed/pushed blob equals the worktree
 * blob the suite tested, ONE pass satisfies both gates across the full
 * stage → commit → push lifecycle; any drift in a covered file (or a new untested
 * file entering the push range) changes the hash and re-blocks.
 *
 * Caveat: batched unpushed commits widen the push range to the full
 * `<pushBase>..HEAD`; a pass must cover that combined content (or use CTX_E2E_SKIP).
 *
 * @param {string} cwd
 * @param {string} gitCommand
 * @param {'commit'|'push'} [mode]
 * @returns {{trivial:boolean, files:string[], baseSha:string, candidateHash:string}|{error:string}}
 */
function computeCandidate(cwd, gitCommand, mode = 'commit') {
  const root = repoRoot(cwd);
  if (!root) return { error: 'not-a-git-repo' };

  let baseSha;
  try {
    baseSha = git(root, ['rev-parse', 'HEAD']);
  } catch {
    baseSha = 'NO_HEAD'; // initial commit, no HEAD yet
  }

  let names = [];
  let blobOf;

  if (mode === 'push') {
    const pb = pushBase(root);
    if (!pb) {
      // No resolvable remote base → fall back to the commit-mode candidate so a
      // dirty worktree is still gated; a clean tree is trivially allowed.
      return computeCandidate(cwd, gitCommand, 'commit');
    }
    try {
      names = git(root, ['diff', '--name-only', `${pb}..HEAD`]).split('\n').filter(Boolean);
    } catch (e) {
      return { error: 'git-range-failed: ' + errMsg(e) };
    }
    blobOf = (f) => blobAtHead(root, f);
  } else {
    const includeUnstaged = hasAllFlag(gitCommand);
    try {
      names = git(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
      if (includeUnstaged) {
        const unstaged = git(root, ['diff', '--name-only']).split('\n').filter(Boolean);
        names = Array.from(new Set([...names, ...unstaged]));
      }
    } catch (e) {
      return { error: 'git-diff-failed: ' + errMsg(e) };
    }
    blobOf = (f) => blobInWorktree(root, f);
  }

  const files = names.filter(isNonTrivial).sort();
  if (files.length === 0) {
    return { trivial: true, files: [], baseSha, candidateHash: '' };
  }

  return { trivial: false, files, baseSha, candidateHash: contentHash(files, blobOf) };
}

/** Detect `-a`, `--all`, or a combined short flag containing 'a' (e.g. `-am`). */
function hasAllFlag(gitCommand) {
  const toks = String(gitCommand).split(/\s+/);
  for (const t of toks) {
    if (t === '--all') return true;
    if (/^-[a-z]*a[a-z]*$/i.test(t) && !t.startsWith('--')) return true; // -a, -am, -na ...
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sentinel read / write / match
// ---------------------------------------------------------------------------

function verifyDir(root) {
  return path.join(root, '.planning', 'verify');
}
function latestPointer(root) {
  return path.join(verifyDir(root), 'latest-e2e-pass.json');
}

function atomicWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.tmp.${Math.abs(hashInt(filePath + obj.ts))}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8' });
  fs.renameSync(tmp, filePath);
}
function hashInt(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Write a pass-sentinel. Called by the Playwright teardown on GREEN only.
 * @param {string} cwd
 * @param {object} fields {candidateHash, baseSha, files, checklistResults,
 *                         assertionCount, artifactsDir, billableSpawns, ts}
 */
function writeSentinel(cwd, fields) {
  const root = repoRoot(cwd);
  if (!root) throw new Error('not-a-git-repo');
  const ts = fields.ts || new Date().toISOString();
  const sentinel = {
    schema_version: SCHEMA_VERSION,
    base_commit_sha: fields.baseSha,
    candidate_hash: fields.candidateHash,
    files: fields.files || [],
    checklist_results: fields.checklistResults || [],
    assertion_count: fields.assertionCount || 0,
    artifacts_dir: fields.artifactsDir || null,
    process_audit: { billable_spawns: fields.billableSpawns != null ? fields.billableSpawns : -1 },
    ts,
  };
  const stamp = ts.replace(/[:.]/g, '').replace('T', 'T').replace('Z', '');
  const out = path.join(verifyDir(root), stamp, 'e2e-pass.json');
  atomicWriteJson(out, sentinel);
  atomicWriteJson(latestPointer(root), sentinel);
  return out;
}

/**
 * Find a sentinel that honestly covers `candidate`.
 * Match requires: same candidate_hash (content fingerprint) AND
 * process_audit.billable_spawns === 0. The hash is content-bound, so it stays
 * valid as HEAD advances from commit to push as long as the covered files'
 * content is unchanged — no separate base-SHA check is needed (or correct).
 * @returns {{ok:true, sentinel:object}|{ok:false, reason:string}}
 */
function findMatchingPass(cwd, candidate) {
  const root = repoRoot(cwd);
  if (!root) return { ok: false, reason: 'not-a-git-repo' };
  const ptr = latestPointer(root);
  if (!fs.existsSync(ptr)) return { ok: false, reason: 'no-pass-sentinel' };

  let s;
  try {
    s = JSON.parse(fs.readFileSync(ptr, 'utf8'));
  } catch {
    return { ok: false, reason: 'pass-sentinel-unreadable' };
  }
  if (s.schema_version !== SCHEMA_VERSION) return { ok: false, reason: 'pass-sentinel-schema-mismatch' };
  if (s.candidate_hash !== candidate.candidateHash) return { ok: false, reason: 'stale-pass (code changed since last E2E run)' };
  if (!s.process_audit || s.process_audit.billable_spawns !== 0) return { ok: false, reason: 'pass had billable spawns (not zero-bill)' };
  return { ok: true, sentinel: s };
}

// ---------------------------------------------------------------------------
// Governed skip — explicit env var only (NOT a model-writable file)
// ---------------------------------------------------------------------------

/**
 * Honor CTX_E2E_SKIP="<reason>" as an explicit, audited bypass.
 * Logs base SHA + reason to .planning/verify/skips.log.
 * @returns {boolean} true if a skip was granted
 */
function checkSkip(cwd, candidate, env) {
  const reason = env && env.CTX_E2E_SKIP;
  if (!reason || !String(reason).trim()) return false;
  const root = repoRoot(cwd);
  if (root) {
    try {
      const line = `${new Date().toISOString()} base=${candidate.baseSha || '?'} files=${(candidate.files || []).length} reason=${String(reason).replace(/\n/g, ' ')}\n`;
      fs.mkdirSync(verifyDir(root), { recursive: true });
      fs.appendFileSync(path.join(verifyDir(root), 'skips.log'), line);
    } catch {
      /* best-effort logging */
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Top-level gate evaluation
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {string} gitCommand
 * @param {NodeJS.ProcessEnv} env
 * @param {'commit'|'push'} [mode] which boundary is being gated
 * @returns {{allow:boolean, reason:string, candidate?:object}}
 */
function evaluateGate(cwd, gitCommand, env, mode = 'commit') {
  let candidate;
  try {
    candidate = computeCandidate(cwd, gitCommand, mode);
  } catch (e) {
    // Fail-closed, but always leave an escape hatch in the message.
    return { allow: false, reason: `e2e-gate error computing candidate: ${e && e.message}` };
  }

  if (candidate.error) {
    if (candidate.error === 'not-a-git-repo') return { allow: true, reason: 'not-a-git-repo' };
    // Fail-closed on genuine evaluation failure.
    return { allow: false, reason: `e2e-gate could not evaluate change (${candidate.error})` };
  }

  if (candidate.trivial) return { allow: true, reason: 'no non-trivial change', candidate };

  if (checkSkip(cwd, candidate, env)) {
    return { allow: true, reason: 'CTX_E2E_SKIP granted (logged)', candidate };
  }

  const match = findMatchingPass(cwd, candidate);
  if (match.ok) return { allow: true, reason: 'fresh E2E pass-sentinel matches', candidate };
  return { allow: false, reason: match.reason, candidate };
}

module.exports = {
  SCHEMA_VERSION,
  isNonTrivial,
  computeCandidate,
  writeSentinel,
  findMatchingPass,
  checkSkip,
  evaluateGate,
  repoRoot,
};

// ---------------------------------------------------------------------------
// CLI — `node e2e-gate-core.js write '<json>'` used by the Playwright teardown.
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [, , cmd, arg] = process.argv;
  if (cmd === 'write') {
    const fields = JSON.parse(arg || '{}');
    const cwd = fields.cwd || process.cwd();
    const out = writeSentinel(cwd, fields);
    process.stdout.write(`wrote ${out}\n`);
  } else if (cmd === 'candidate') {
    // Debug helper: print the candidate. Optional 3rd arg = mode ('commit'|'push').
    const mode = process.argv[4] === 'push' ? 'push' : 'commit';
    process.stdout.write(JSON.stringify(computeCandidate(process.cwd(), arg || 'git commit', mode), null, 2) + '\n');
  } else {
    process.stderr.write('usage: e2e-gate-core.js write|candidate <json> [mode]\n');
    process.exit(1);
  }
}
