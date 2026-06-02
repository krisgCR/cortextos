// cortextOS Dashboard - Agent avatar glyph resolution
// A real emoji set in IDENTITY.md always wins. When the field is empty, a
// leftover placeholder comment (e.g. "<!-- Optional emoji identifier -->"), or
// plain text, we fall back to a deterministic per-name emoji so every agent gets
// a clean, distinct avatar instead of leaking the template comment.

// Curated set of single-grapheme, widely-rendered emojis. Order is part of the
// hash mapping — appending is safe, reordering reshuffles existing assignments.
const AGENT_EMOJIS = [
  '🤖', '🦊', '🦉', '🐙', '🦅', '🐝', '🦫', '🦝', '🐧', '🦜',
  '🐢', '🦦', '🐳', '🦄', '🐉', '🦚', '🦩', '🐡', '🐺', '🦬',
] as const;

// FNV-1a — small, fast, well-distributed for short ASCII agent names.
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic emoji for an agent name. Same name → same emoji, always. */
export function autoEmoji(name: string): string {
  if (!name) return AGENT_EMOJIS[0];
  return AGENT_EMOJIS[hashString(name) % AGENT_EMOJIS.length];
}

/** Remove HTML comments (the IDENTITY.md template placeholders). */
export function stripHtmlComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, '');
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/**
 * Resolve the glyph to render in an agent avatar.
 * - A real emoji set in IDENTITY.md (contains a pictographic codepoint) wins.
 * - Empty / comment-only / plain-text fields fall back to a per-name emoji.
 */
export function resolveAgentEmoji(name: string, rawEmoji?: string): string {
  const clean = stripHtmlComments(rawEmoji ?? '').trim();
  if (clean && PICTOGRAPHIC.test(clean)) return clean;
  return autoEmoji(name);
}
