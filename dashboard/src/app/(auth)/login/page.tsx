'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SplashScreen } from '@/components/layout/splash-screen';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showSplash, setShowSplash] = useState(false);

  // Redirect to setup if no users exist
  useEffect(() => {
    fetch('/api/setup')
      .then((res) => res.json())
      .then((data) => {
        if (data.needsSetup) {
          router.push('/setup');
        }
      })
      .catch(() => {});
  }, [router]);

  // CSRF token strategy: fetch once, hold in a ref, inject on submit.
  // React state bound with value={csrfToken} and imperative writes via
  // querySelector both fail — React reconciliation resets uncontrolled
  // input values between the useEffect completion and the next render, so
  // the hidden input never carries the real token at submit time. The
  // hidden input in the JSX below is a placeholder; the real token is put
  // on the request body in handleSubmit().
  const csrfTokenRef = useRef<string>('');
  const [csrfReady, setCsrfReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
        const data = await res.json();
        if (cancelled) return;
        const token = data?.csrfToken;
        if (!token) {
          console.error('[login] /api/auth/csrf returned no token', data);
          return;
        }
        csrfTokenRef.current = token;
        setCsrfReady(true);
      } catch (err) {
        console.error('[login] csrf fetch failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // POST the credentials callback ourselves with an
    // application/x-www-form-urlencoded body. NextAuth's CSRF validator
    // reads the csrfToken field from urlencoded bodies; a multipart/form-data
    // body (what `new FormData()` produces) fails with MissingCSRF because
    // the parser doesn't recover the token from the multipart stream.
    // Bypassing signIn() from next-auth/react lets us control the exact body.
    e.preventDefault();
    setLoading(true);
    setError('');

    const form = e.currentTarget;
    const usernameInput = form.querySelector('input[name="username"]') as HTMLInputElement | null;
    const passwordInput = form.querySelector('input[name="password"]') as HTMLInputElement | null;

    // Re-fetch CSRF token at submit time so body token matches the current
    // cookie. React StrictMode double-invokes the mount-time CSRF useEffect
    // in dev; if the two in-flight /api/auth/csrf responses resolve out of
    // order, the browser's authjs.csrf-token cookie can end up pinned to a
    // different token than csrfTokenRef.current — which the server rejects
    // as MissingCSRF. An atomic fetch-then-submit here forces cookie and
    // body into sync regardless of earlier mount-time races.
    let submitToken = csrfTokenRef.current;
    try {
      const freshCsrf = await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' });
      const freshData = await freshCsrf.json();
      if (freshData?.csrfToken) submitToken = freshData.csrfToken;
    } catch {
      // Fall back to the mount-time token if the refetch fails.
    }

    const body = new URLSearchParams();
    body.set('csrfToken', submitToken || '');
    body.set('username', usernameInput?.value || '');
    body.set('password', passwordInput?.value || '');

    try {
      // Ask Auth.js to return the post-sign-in target as JSON instead of issuing
      // a 302. The X-Auth-Return-Redirect header makes the credentials callback
      // respond 200 { url } — the same transport next-auth/react's signIn() uses.
      //
      // Why not just follow the 302: Auth.js derives its base URL from the
      // request host as http://localhost:<port>/, but the browser origin is
      // http://127.0.0.1:<port> (or a Tailscale host). `redirect: 'follow'` then
      // chases a CROSS-ORIGIN redirect that the browser CORS-blocks
      // (net::ERR_FAILED → "Failed to fetch"), even though the session cookie was
      // already set — i.e. login succeeded but the user saw "Network error".
      const res = await fetch(form.action, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Auth-Return-Redirect': '1',
        },
        body: body.toString(),
        credentials: 'same-origin',
      });

      if (!res.ok) {
        setError(`Sign-in failed with status ${res.status}`);
        setLoading(false);
        return;
      }

      // On both success and auth failure Auth.js returns 200 { url }. A failure
      // url carries ?error=<code> (e.g. CredentialsSignin); success does not.
      const data = (await res.json().catch(() => null)) as { url?: string } | null;
      const returnedError = data?.url
        ? new URL(data.url, window.location.origin).searchParams.get('error')
        : null;

      if (returnedError) {
        // CallbackRouteError usually means the rate limiter blocked the request;
        // CredentialsSignin means the username/password was rejected. Map both to
        // human-readable copy instead of the raw error code.
        const msg = returnedError === 'CallbackRouteError'
          ? 'Too many attempts. Please wait a few minutes and try again.'
          : returnedError === 'CredentialsSignin'
            ? 'Invalid username or password.'
            : `Sign-in failed: ${returnedError}`;
        setError(msg);
        setLoading(false);
        return;
      }

      // Success. Navigate to the original destination the user tried to reach, or
      // / if none was recorded. Build a relative-only same-origin target — never
      // navigate to data.url, which can be http://localhost:<port>/ (the wrong
      // host behind a proxy or loopback alias).
      const callbackParam = new URL(window.location.href).searchParams.get('callbackUrl');
      // Validate same-origin: must start with / but not // (which is a protocol-relative URL)
      const safeTarget = callbackParam && callbackParam.startsWith('/') && !callbackParam.startsWith('//') ? callbackParam : '/';
      window.location.href = safeTarget;
    } catch (err) {
      console.error('[login] submit error:', err);
      setError('Network error. Please try again.');
      setLoading(false);
    }
  }

  // Splash just needs to stay visible long enough - navigation happens in parallel
  const handleSplashComplete = useCallback(() => {
    // No-op: navigation already started above
  }, []);

  return (
    <>
      {showSplash && <SplashScreen onComplete={handleSplashComplete} />}
    <div className={`flex min-h-screen items-center justify-center bg-gradient-to-br from-background via-muted to-background ${showSplash ? 'invisible' : ''}`}>
      <div className="w-full max-w-sm space-y-6 px-4">
        {/* Logo */}
        <div className="text-center space-y-2">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground text-lg font-bold">
            cO
          </div>
          <h1 className="text-xl font-semibold tracking-tight">cortextOS</h1>
          <p className="text-sm text-muted-foreground">
            Persistent AI Agent Orchestration
          </p>
        </div>

        {/* Login Card */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Sign in</CardTitle>
            <CardDescription className="text-xs">
              Enter your credentials to access the dashboard
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} method="POST" action="/api/auth/callback/credentials" className="space-y-4" suppressHydrationWarning>
              <input type="hidden" name="csrfToken" defaultValue="" suppressHydrationWarning />
              <div className="space-y-1.5">
                <Label htmlFor="username" className="text-xs">Username</Label>
                <Input
                  id="username"
                  name="username"
                  type="text"
                  required
                  autoFocus
                  placeholder="admin"
                  suppressHydrationWarning
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-xs">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  placeholder="Enter password"
                  suppressHydrationWarning
                />
              </div>
              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}
              <Button type="submit" className="w-full" disabled={loading || !csrfReady}>
                {loading ? 'Signing in...' : csrfReady ? 'Sign In' : 'Loading…'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-[11px] text-muted-foreground/60">
          cortextOS v2
        </p>
      </div>
    </div>
    </>
  );
}
