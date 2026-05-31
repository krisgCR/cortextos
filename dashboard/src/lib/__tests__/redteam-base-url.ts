/**
 * Red-team test helpers: base-URL parametrization and route enumeration.
 *
 * Set REDTEAM_BASE_URL to target a live origin (e.g. https://host.ts.net).
 * Without it, network sweeps are skipped (mocked-middleware tests always run).
 *
 * REDTEAM_SESSION_TOKEN: set to a real login-issued authjs.session-token
 * for the positive-auth smoke in auth-middleware.test.ts [CR1].
 */
import { readdirSync } from 'fs';
import { join, relative, resolve } from 'path';

/** Returns the red-team target base URL (default: local dev server). */
export function getBaseUrl(): string {
  return process.env.REDTEAM_BASE_URL ?? 'http://127.0.0.1:3000';
}

/**
 * Returns the absolute path to the dashboard/src/app/api directory.
 * Assumes vitest CWD is the dashboard/ package root.
 */
export function getApiDir(): string {
  return resolve(process.cwd(), 'src/app/api');
}

function walkRouteFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRouteFiles(full, results);
    } else if (entry.name === 'route.ts') {
      results.push(full);
    }
  }
  return results;
}

/**
 * Converts a route.ts absolute path to a URL path with concrete placeholders.
 *   .../api/agents/[name]/route.ts       →  /api/agents/test-id
 *   .../api/media/[...filepath]/route.ts →  /api/media/test-file
 */
function routeFileToUrlPath(absRoute: string, apiDir: string): string {
  const rel = relative(apiDir, absRoute); // e.g. agents/[name]/route.ts
  const dir = rel.replace(/[/\\]route\.ts$/, ''); // e.g. agents/[name]
  const urlPath = dir
    .replace(/\[\.\.\.([^\]]+)\]/g, 'test-file') // [...name] → test-file
    .replace(/\[([^\]]+)\]/g, 'test-id');          // [name]   → test-id
  return '/api/' + urlPath;
}

/**
 * Enumerates all concrete API routes from the filesystem.
 * Excludes auth/* (NextAuth — intentionally open) and workflows/health (GAP-0034 allowlist).
 * Pass getApiDir() as apiDir for the default dashboard route tree.
 */
export function enumerateApiRoutes(apiDir: string): string[] {
  return walkRouteFiles(apiDir)
    .map(f => routeFileToUrlPath(f, apiDir))
    .filter(p => !p.startsWith('/api/auth/'))
    .filter(p => p !== '/api/workflows/health')
    .sort();
}

/**
 * Returns URL path variants to probe for middleware-matcher bypass:
 *   - canonical path
 *   - trailing-slash variant
 *   - percent-encoded last segment
 * Deduplicates (canonical = encoded when no special chars present).
 */
export function pathVariants(path: string): string[] {
  const trailingSlash = path + '/';
  const encoded = path.replace(/\/([^/]+)$/, (_, last) => '/' + encodeURIComponent(last));
  return Array.from(new Set([path, trailingSlash, encoded]));
}
