import { describe, it, expect } from 'vitest';
import { validateAuthSecret } from '../auth-secret-assert';

// The installer generates: randomBytes(32).toString("hex") = 64 hex chars.
// This must pass — it is the real deployed value shape (Fragile Assumption 3).
// We construct it programmatically so we do not embed a literal credential-like string.
const hexChars = 'abcdef0123456789';
function makeHexString(len: number): string {
  return hexChars.slice(0, 4).repeat(len / 4); // e.g. "abcd".repeat(16) = 64 chars
}

const installerShapedValue = makeHexString(64); // 64-char hex string — the real installer shape

describe('validateAuthSecret', () => {
  describe('PASS cases', () => {
    it('accepts a 32-char value', () => {
      expect(validateAuthSecret('x'.repeat(32)).valid).toBe(true);
    });

    it('accepts a 64-char installer-shaped value (randomBytes(32).toString("hex"))', () => {
      // This is the exact shape the installer writes — must never be rejected
      expect(validateAuthSecret(installerShapedValue).valid).toBe(true);
    });

    it('accepts values longer than 64 chars', () => {
      expect(validateAuthSecret('z'.repeat(128)).valid).toBe(true);
    });

    it('does not check charset — alphanumeric 32-char values pass', () => {
      const alphanumeric = 'abcdefghijklmnopqrstuvwxyz012345'; // 32 chars
      expect(validateAuthSecret(alphanumeric).valid).toBe(true);
    });
  });

  describe('FAIL cases', () => {
    it('rejects undefined (env var not set)', () => {
      const result = validateAuthSecret(undefined);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/not set/);
    });

    it('rejects empty string', () => {
      const result = validateAuthSecret('');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/empty/);
    });

    it('rejects a 31-char value (below minimum)', () => {
      const result = validateAuthSecret('a'.repeat(31));
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/too short/);
    });

    it('rejects a 1-char value', () => {
      expect(validateAuthSecret('x').valid).toBe(false);
    });

    it('rejects known placeholder "changeme"', () => {
      const result = validateAuthSecret('changeme');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/placeholder/);
    });

    it('rejects known placeholder "secret"', () => {
      expect(validateAuthSecret('secret').valid).toBe(false);
    });

    it('rejects known placeholder "your-secret-here"', () => {
      expect(validateAuthSecret('your-secret-here').valid).toBe(false);
    });

    it('rejects known placeholder "password"', () => {
      expect(validateAuthSecret('password').valid).toBe(false);
    });

    it('rejects placeholder names case-insensitively', () => {
      expect(validateAuthSecret('CHANGEME').valid).toBe(false);
      expect(validateAuthSecret('Password').valid).toBe(false);
    });

    it('rejects a 31-char value even if it looks non-trivial', () => {
      const almostLong = 'z9#$k!mP2@wQ8vR4nX6hL3bY7jE0cT1'; // 31 chars
      expect(validateAuthSecret(almostLong).valid).toBe(false);
    });
  });
});
