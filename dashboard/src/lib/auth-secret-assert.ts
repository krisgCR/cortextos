// AUTH_SECRET startup assertion — validates the secret meets minimum strength before the
// server accepts any traffic. This is the LOUD startup layer; the per-request 500 in
// middleware.ts:111-125 remains as the runtime backstop.
//
// Strength rule: present AND length ≥ 32 AND not in a known-placeholder set.
// The installer 64-hex secret (randomBytes(32).toString("hex") = 64 chars) always passes.
// No entropy/charset checks: they would false-positive on the installer-generated value.

const KNOWN_PLACEHOLDERS = new Set([
  'changeme',
  'secret',
  'your-secret-here',
  'your_secret_here',
  'mysecret',
  'test',
  'password',
  'replace-me',
  'example-secret',
  'insert-secret-here',
  'placeholder',
]);

export interface SecretValidation {
  valid: boolean;
  reason?: string;
}

/**
 * Pure validator — unit-testable, no side effects.
 * Returns { valid: true } iff the secret is present, ≥32 chars, and not a known placeholder.
 */
export function validateAuthSecret(value: string | undefined): SecretValidation {
  if (value === undefined || value === null) {
    return { valid: false, reason: 'AUTH_SECRET/NEXTAUTH_SECRET is not set' };
  }
  if (value.length === 0) {
    return { valid: false, reason: 'AUTH_SECRET/NEXTAUTH_SECRET is empty' };
  }
  // Placeholder check before length: gives a more informative message than "too short"
  // when the value is a well-known default like "changeme" or "secret".
  if (KNOWN_PLACEHOLDERS.has(value.toLowerCase())) {
    return { valid: false, reason: 'AUTH_SECRET matches a known placeholder — set a real secret' };
  }
  if (value.length < 32) {
    return {
      valid: false,
      reason: `AUTH_SECRET is too short (${value.length} chars — minimum 32)`,
    };
  }
  return { valid: true };
}

/**
 * Startup assertion — call once at server boot.
 * Exits the process loudly if AUTH_SECRET/NEXTAUTH_SECRET is missing, weak, or a placeholder.
 * Reads from process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET (same as middleware.ts:96).
 */
export function assertAuthSecret(): void {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  const result = validateAuthSecret(secret);
  if (!result.valid) {
    const line = `║  ${result.reason ?? 'invalid secret'}`;
    const padded = line.padEnd(65) + '║';
    console.error(
      '\n' +
      '╔═══════════════════════════════════════════════════════════════╗\n' +
      '║  cortextOS FATAL: invalid AUTH_SECRET                        ║\n' +
      padded + '\n' +
      '║  Set AUTH_SECRET in .env.local (≥32 chars, not a placeholder) ║\n' +
      '║  then restart the server.                                     ║\n' +
      '╚═══════════════════════════════════════════════════════════════╝\n',
    );
    process.exit(1);
  }
}
