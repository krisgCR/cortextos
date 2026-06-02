/**
 * Avatar glyph resolution: a real emoji from IDENTITY.md wins; empty,
 * comment-only (the template placeholder), or plain-text fields fall back to a
 * deterministic per-name emoji. Pins the fix for the "<!-- Optional emoji
 * identifier -->" comment leaking into the avatar circle.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveAgentEmoji,
  autoEmoji,
  stripHtmlComments,
} from '@/lib/agent-emoji';

describe('stripHtmlComments', () => {
  it('removes the IDENTITY.md placeholder comment', () => {
    expect(stripHtmlComments('<!-- Optional emoji identifier -->').trim()).toBe('');
  });
  it('leaves non-comment text untouched', () => {
    expect(stripHtmlComments('🤖')).toBe('🤖');
  });
});

describe('autoEmoji', () => {
  it('is deterministic for a given name', () => {
    expect(autoEmoji('codex-1')).toBe(autoEmoji('codex-1'));
  });
  it('returns a single curated emoji (pictographic)', () => {
    expect(autoEmoji('researcher')).toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('resolveAgentEmoji', () => {
  it('falls back to an auto emoji for the comment-only placeholder', () => {
    const glyph = resolveAgentEmoji('claude-1', '<!-- Optional emoji identifier -->');
    expect(glyph).toBe(autoEmoji('claude-1'));
    expect(glyph).not.toContain('<!--');
  });

  it('falls back to an auto emoji for an empty / undefined field', () => {
    expect(resolveAgentEmoji('claude-1', '')).toBe(autoEmoji('claude-1'));
    expect(resolveAgentEmoji('claude-1', undefined)).toBe(autoEmoji('claude-1'));
  });

  it('falls back to an auto emoji for plain text', () => {
    expect(resolveAgentEmoji('claude-1', 'orchestrator')).toBe(autoEmoji('claude-1'));
  });

  it('uses a real emoji set in IDENTITY.md verbatim', () => {
    expect(resolveAgentEmoji('claude-1', '🛠️')).toBe('🛠️');
  });

  it('gives the five overseer agents distinct emojis', () => {
    const names = ['claude-1', 'codex-1', 'implementer-1', 'implementer-2', 'researcher'];
    const glyphs = names.map((n) => resolveAgentEmoji(n));
    expect(new Set(glyphs).size).toBe(names.length);
  });
});
