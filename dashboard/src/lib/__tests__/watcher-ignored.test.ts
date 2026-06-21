/**
 * Regression guard for the chokidar watch-exclusion set (isIgnoredWatchPath).
 *
 * Added after a 90GB OOM (2026-06-21): the dashboard watcher must never descend
 * into build artifacts, vendored deps, or the SQLite DB + WAL sidecars. These
 * assertions pin the exclusion set so it can't silently drift — and so it never
 * over-excludes the runtime/heartbeat/task/approval files the dashboard relies on.
 */
import { describe, it, expect } from 'vitest';
import { isIgnoredWatchPath } from '../watcher';

describe('isIgnoredWatchPath', () => {
  const ROOT = '/Users/x/.cortextos/default';

  it.each([
    `${ROOT}/node_modules/foo/index.js`,
    `${ROOT}/state/.git/HEAD`,
    `${ROOT}/dashboard/.next/cache/chunk.js`,
    `${ROOT}/dist/bundle.js`,
    `${ROOT}/state/codex-1/codex-home/sock`,
    `${ROOT}/state/codex-1/agent.sock`,
    `${ROOT}/dashboard/cortextos-default.db`,
    `${ROOT}/dashboard/cortextos-default.db-wal`,
    `${ROOT}/dashboard/cortextos-default.db-shm`,
    `${ROOT}/orgs/overseer/.next/server.js`,
  ])('ignores %s', (p) => {
    expect(isIgnoredWatchPath(p)).toBe(true);
  });

  it.each([
    `${ROOT}/state/runtimes/run-abc123.json`,
    `${ROOT}/state/some-agent/heartbeat.json`,
    `${ROOT}/orgs/overseer/tasks/t-1.json`,
    `${ROOT}/orgs/overseer/approvals/a-1.json`,
    `${ROOT}/orgs/overseer/analytics/events/agent/events.jsonl`,
    `${ROOT}/inbox/msg.json`,
  ])('does NOT ignore relevant file %s', (p) => {
    expect(isIgnoredWatchPath(p)).toBe(false);
  });
});
