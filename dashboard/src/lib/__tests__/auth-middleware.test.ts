/**
 * Regression tests — GAP-0030 forged cookie + SSE auth on connect & reconnect
 *
 * GAP-0030 (2026-05-16): previous middleware checked only `request.cookies.has()`
 * (name-only presence). Any `Cookie: authjs.session-token=anything` bypassed auth.
 * Fix: replaced with `getToken` from next-auth/jwt which does full JWE verification.
 * These tests prove the cryptographic verification gate is in place.
 *
 * SSE auth:
 * - events/stream: uses NextAuth session cookie (auth() call)
 * - messages/stream/[agent]: uses ?token=<jwt> query param (jwtVerify)
 * Both are re-authenticated on every connection — there is no Last-Event-ID session
 * resume, so reconnect = new GET = same auth requirement.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(),
}));

vi.mock('jose', () => ({
  jwtVerify: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

// Prevent SSE watcher side-effects in tests
vi.mock('@/lib/watcher', () => ({
  initWatcher: vi.fn(),
  onSSEEvent: vi.fn(() => () => {}),
}));

import { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { jwtVerify } from 'jose';
import { auth } from '@/lib/auth';

const mockGetToken = vi.mocked(getToken);
const mockJwtVerify = vi.mocked(jwtVerify);
const mockAuth = vi.mocked(auth);

// Defer middleware and route imports until after mocks are set (vitest hoisting handles it,
// but explicit dynamic import makes the dependency clear).
let middlewareFn: (typeof import('../../middleware'))['middleware'];
let eventsStreamGET: (typeof import('../../app/api/events/stream/route'))['GET'];
let messagesStreamGET: (typeof import('../../app/api/messages/stream/[agent]/route'))['GET'];

beforeEach(async () => {
  vi.clearAllMocks();
  // Set a valid AUTH_SECRET so middleware doesn't fall into the "no secret" 500 branch
  process.env.AUTH_SECRET = 'a'.repeat(64);

  const mw = await import('../../middleware');
  middlewareFn = mw.middleware;

  const eventsRoute = await import('../../app/api/events/stream/route');
  eventsStreamGET = eventsRoute.GET;

  const messagesRoute = await import('../../app/api/messages/stream/[agent]/route');
  messagesStreamGET = messagesRoute.GET;
});

afterEach(() => {
  delete process.env.AUTH_SECRET;
});

// ---------------------------------------------------------------------------
// GAP-0030 — forged/invalid session cookie must be cryptographically rejected
// ---------------------------------------------------------------------------

describe('GAP-0030: forged session cookie rejection', () => {
  it('returns 401 when authjs.session-token has an arbitrary forged value', async () => {
    // Simulate getToken returning null for a cookie that is syntactically present
    // but fails JWE verification (the exact pre-fix exploit scenario).
    mockGetToken.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/approvals', {
      method: 'GET',
      headers: { cookie: 'authjs.session-token=totally-forged-value' },
    });

    const res = await middlewareFn(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 for any non-allowlisted API route when getToken returns null', async () => {
    mockGetToken.mockResolvedValue(null);
    const paths = ['/api/agents', '/api/tasks', '/api/events', '/api/settings'];
    for (const pathname of paths) {
      const req = new NextRequest(`http://localhost:3000${pathname}`);
      const res = await middlewareFn(req);
      expect(res.status).toBe(401);
    }
  });

  it('allows request through when getToken returns a valid session token', async () => {
    // Simulate a legitimately-issued session
    mockGetToken.mockResolvedValue({ id: '1', name: 'admin' } as ReturnType<typeof getToken> extends Promise<infer T> ? T : never);

    const req = new NextRequest('http://localhost:3000/api/agents');
    const res = await middlewareFn(req);
    // Middleware passes through — status is not 401/500
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(500);
  });
});

// ---------------------------------------------------------------------------
// SSE auth — events/stream (NextAuth session cookie)
// ---------------------------------------------------------------------------

describe('SSE auth: /api/events/stream', () => {
  it('returns 401 on first connect without auth', async () => {
    mockAuth.mockResolvedValue(null as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    const req = new NextRequest('http://localhost:3000/api/events/stream');
    const res = await eventsStreamGET(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 on reconnect (new GET without auth) — no Last-Event-ID resume exists', async () => {
    // A reconnect is just a new GET. There is no Last-Event-ID based session resume
    // in this SSE implementation (events/stream/route.ts:36 — no reconnect path).
    // Each new connection MUST re-authenticate.
    mockAuth.mockResolvedValue(null as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    const reconnect = new NextRequest('http://localhost:3000/api/events/stream', {
      headers: { 'Last-Event-ID': '123' }, // SSE reconnect header — ignored, still needs auth
    });
    const res = await eventsStreamGET(reconnect);
    expect(res.status).toBe(401);
  });

  it('opens the stream when session auth passes', async () => {
    mockAuth.mockResolvedValue({ user: { id: '1' } } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    const req = new NextRequest('http://localhost:3000/api/events/stream');
    const res = await eventsStreamGET(req);
    // Stream response — status 200 and SSE content type
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
  });
});

// ---------------------------------------------------------------------------
// SSE auth — messages/stream/[agent] (?token= JWT query param)
// ---------------------------------------------------------------------------

describe('SSE auth: /api/messages/stream/[agent]', () => {
  const params = { params: Promise.resolve({ agent: 'test-agent' }) };

  it('returns 401 when ?token param is absent', async () => {
    const req = new NextRequest('http://localhost:3000/api/messages/stream/test-agent');
    const res = await messagesStreamGET(req, params);
    expect(res.status).toBe(401);
  });

  it('returns 401 when ?token is present but jwtVerify rejects it', async () => {
    mockJwtVerify.mockRejectedValue(new Error('JWTSignatureVerificationFailed'));

    const req = new NextRequest(
      'http://localhost:3000/api/messages/stream/test-agent?token=forged.jwt.token',
    );
    const res = await messagesStreamGET(req, params);
    expect(res.status).toBe(401);
  });

  it('returns 401 on reconnect (new GET without valid token)', async () => {
    // Reconnect = new GET = same auth gate. The SSE implementation has no
    // credential-passing reconnect; the client must re-present the token.
    mockJwtVerify.mockRejectedValue(new Error('JWTExpired'));

    const reconnect = new NextRequest(
      'http://localhost:3000/api/messages/stream/test-agent?token=expired.token',
      { headers: { 'Last-Event-ID': '42' } },
    );
    const res = await messagesStreamGET(reconnect, params);
    expect(res.status).toBe(401);
  });

  it('opens the stream when jwtVerify succeeds', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: '1' }, protectedHeader: { alg: 'HS256' } } as unknown as Awaited<ReturnType<typeof jwtVerify>>);

    const req = new NextRequest(
      'http://localhost:3000/api/messages/stream/test-agent?token=valid.jwt.token',
    );
    const res = await messagesStreamGET(req, params);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
  });
});
