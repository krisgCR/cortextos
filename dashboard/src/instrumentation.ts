// Next.js server instrumentation — runs once at startup before the server handles any request.
// Used here to assert AUTH_SECRET strength so a misconfigured deploy fails loudly at boot,
// not silently at runtime.
//
// Node.js runtime only: the Edge runtime cannot call process.exit(), and the secret check
// is meaningless there anyway (the per-request 500 in middleware.ts is the Edge backstop).
// Fork-delta: new file, additive only.

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertAuthSecret } = await import('./lib/auth-secret-assert');
    assertAuthSecret();
  }
}
