/**
 * §8.5 Unauthenticated route sweep — automated red-team for the API surface.
 *
 * Every /api/* route group must return 401 (or redirect to /login for page routes)
 * when hit without a valid session — EXCEPT the named by-design-open allowlist below.
 *
 * By-design-open allowlist (documented for red-team §8.5 evidence):
 *   /login                   — login page, must be reachable unauthenticated
 *   /api/auth/*              — NextAuth endpoints (sign-in, callback, CSRF, session probe)
 *   /_next/*                 — Next.js static assets (matched in middleware config)
 *   /favicon.ico             — favicon
 *   /api/workflows/health    — GAP-0034: unauthenticated health probe for monitoring/watchdogs
 *
 * All 22 /api/* groups are covered: agents, analytics, approvals, auth, comms, events,
 * experiments, goals, kb, knowledge, media, messages, notifications, org, orgs, quota,
 * settings, skills, sync, tasks, wiki, workflows (non-health).
 *
 * If an accidentally-open route is found: it is surfaced HERE as a test failure, never
 * silently passed. Fix the route AND document it if it belongs on the allowlist.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';

vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn().mockResolvedValue(null), // All requests unauthenticated
}));

vi.mock('jose', () => ({
  jwtVerify: vi.fn().mockRejectedValue(new Error('not authenticated')),
}));

import { NextRequest } from 'next/server';

let middlewareFn: (typeof import('../../middleware'))['middleware'];

beforeAll(async () => {
  process.env.AUTH_SECRET = 'a'.repeat(64); // valid secret so middleware runs auth check
  const mw = await import('../../middleware');
  middlewareFn = mw.middleware;
});

afterAll(() => {
  delete process.env.AUTH_SECRET;
});

// ---------------------------------------------------------------------------
// By-design-open allowlist — MUST be reachable without auth
// ---------------------------------------------------------------------------

describe('by-design-open allowlist (must NOT return 401)', () => {
  const allowlistPaths = [
    { path: '/login', name: 'login page' },
    { path: '/api/auth/signin', name: 'NextAuth signin' },
    { path: '/api/auth/callback/credentials', name: 'NextAuth callback' },
    { path: '/api/auth/session', name: 'NextAuth session probe' },
    { path: '/api/auth/mobile', name: 'mobile auth (rate-limited)' },
    { path: '/api/workflows/health', name: 'GAP-0034 health probe' },
    { path: '/favicon.ico', name: 'favicon' },
  ];

  for (const { path, name } of allowlistPaths) {
    it(`${name} (${path}) is reachable without auth`, async () => {
      const req = new NextRequest(`http://localhost:3000${path}`);
      const res = await middlewareFn(req);
      // Should NOT be 401
      expect(res.status).not.toBe(401);
      // NextResponse.next() returns 200; redirect returns 3xx
      expect(res.status).not.toBe(500);
    });
  }
});

// ---------------------------------------------------------------------------
// §8.5 sweep — all 22 /api/* groups must return 401 unauthenticated
// ---------------------------------------------------------------------------

describe('§8.5 unauthenticated sweep: all /api/* groups return 401', () => {
  // One representative route per group. The middleware applies to all routes
  // within a group, so a single path per group is sufficient.
  const apiGroups: Array<{ group: string; path: string }> = [
    { group: 'agents', path: '/api/agents' },
    { group: 'analytics', path: '/api/analytics/overview' },
    { group: 'approvals', path: '/api/approvals' },
    // auth/* is on the allowlist — not in this sweep
    { group: 'comms', path: '/api/comms' },
    { group: 'events', path: '/api/events' },
    { group: 'experiments', path: '/api/experiments' },
    { group: 'goals', path: '/api/goals' },
    { group: 'kb', path: '/api/kb' },
    { group: 'knowledge', path: '/api/knowledge' },
    { group: 'media', path: '/api/media' },
    { group: 'messages', path: '/api/messages' },
    { group: 'notifications', path: '/api/notifications' },
    { group: 'org', path: '/api/org' },
    { group: 'orgs', path: '/api/orgs' },
    { group: 'quota', path: '/api/quota' },
    { group: 'settings', path: '/api/settings' },
    { group: 'skills', path: '/api/skills' },
    { group: 'sync', path: '/api/sync' },
    { group: 'tasks', path: '/api/tasks' },
    { group: 'wiki', path: '/api/wiki' },
    { group: 'workflows (non-health)', path: '/api/workflows' },
  ];

  for (const { group, path } of apiGroups) {
    it(`/api/${group} returns 401 without auth`, async () => {
      const req = new NextRequest(`http://localhost:3000${path}`);
      const res = await middlewareFn(req);
      expect(res.status).toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// Confirm allowlist entries are explicitly separate from the sweep
// ---------------------------------------------------------------------------

describe('allowlist routes are NOT in the 401 sweep (sanity check)', () => {
  it('GET /api/auth/* does not return 401 (it is on the allowlist)', async () => {
    const req = new NextRequest('http://localhost:3000/api/auth/signin');
    const res = await middlewareFn(req);
    expect(res.status).not.toBe(401);
  });

  it('GET /api/workflows/health does not return 401 (GAP-0034 health probe)', async () => {
    const req = new NextRequest('http://localhost:3000/api/workflows/health');
    const res = await middlewareFn(req);
    expect(res.status).not.toBe(401);
  });
});
