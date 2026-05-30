/**
 * Unit tests for telemetry-emit.ts
 *
 * Covers:
 * 1. emitHumanPromptEvent: correct event shape written to JSONL
 * 2. emitHumanPromptNonBlocking: swallows a thrown error without propagating
 *    (non-blocking contract — verified so that a logEvent failure never breaks
 *     the dashboard send path; Fragile Assumption 5)
 */

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Set CTX_ROOT before any module loads so config.ts picks it up
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-emit-test-'));
process.env.CTX_ROOT = tmpDir;

// Mock getAllAgents to return a known agent+org pairing
vi.mock('@/lib/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config')>();
  return {
    ...real,
    getAllAgents: () => [{ name: 'test-agent', org: 'test-org' }],
    // getEventsDir and getCTXRoot are kept from the real module (use CTX_ROOT)
  };
});

// Imports happen AFTER the mock is set up (vi.mock is hoisted, but dynamic import ensures order)
let emitHumanPromptEvent: typeof import('../telemetry-emit')['emitHumanPromptEvent'];
let emitHumanPromptNonBlocking: typeof import('../telemetry-emit')['emitHumanPromptNonBlocking'];

beforeAll(async () => {
  const mod = await import('../telemetry-emit');
  emitHumanPromptEvent = mod.emitHumanPromptEvent;
  emitHumanPromptNonBlocking = mod.emitHumanPromptNonBlocking;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CTX_ROOT;
});

// ---------------------------------------------------------------------------
// emitHumanPromptEvent — event shape and JSONL write
// ---------------------------------------------------------------------------

describe('emitHumanPromptEvent', () => {
  it('writes a JSONL line to the correct events path', () => {
    emitHumanPromptEvent('test-agent');

    const today = new Date().toISOString().split('T')[0];
    const eventsDir = path.join(tmpDir, 'orgs', 'test-org', 'analytics', 'events', 'test-agent');
    const logFile = path.join(eventsDir, `${today}.jsonl`);

    expect(fs.existsSync(logFile)).toBe(true);
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it('writes an event with the correct shape', () => {
    const event = emitHumanPromptEvent('test-agent');

    expect(event.category).toBe('message');
    expect(event.event).toBe('human_prompt');
    expect(event.severity).toBe('info');
    expect(event.metadata.source).toBe('dashboard');
    expect(event.agent).toBe('test-agent');
    expect(event.org).toBe('test-org');
    expect(typeof event.id).toBe('string');
    expect(event.id.length).toBeGreaterThan(0);
    expect(typeof event.timestamp).toBe('string');
    // Timestamp must be ISO 8601 without milliseconds (matches daemon logEvent format)
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('writes valid JSON on each line of the JSONL file', () => {
    // Call twice to ensure multiple lines are valid
    emitHumanPromptEvent('test-agent');
    emitHumanPromptEvent('test-agent');

    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(
      tmpDir, 'orgs', 'test-org', 'analytics', 'events', 'test-agent', `${today}.jsonl`,
    );
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      expect(parsed.category).toBe('message');
      expect(parsed.event).toBe('human_prompt');
    }
  });

  it('uses unknown org for an unregistered agent', () => {
    // Agent not in getAllAgents() → org defaults to ''
    const event = emitHumanPromptEvent('unknown-agent');
    expect(event.org).toBe('');
  });
});

// ---------------------------------------------------------------------------
// emitHumanPromptNonBlocking — non-blocking contract (swallows errors)
// ---------------------------------------------------------------------------

describe('emitHumanPromptNonBlocking', () => {
  it('does not throw when the underlying emit succeeds', () => {
    expect(() => emitHumanPromptNonBlocking('test-agent')).not.toThrow();
  });

  it('does not throw — and does not propagate — when the emit itself throws', async () => {
    // Simulate a filesystem error by making CTX_ROOT point to a non-writable path
    const realCTXROOT = process.env.CTX_ROOT;
    process.env.CTX_ROOT = '/dev/null/impossible-path'; // will cause mkdirSync to throw

    // This is the critical non-blocking contract: a logEvent failure MUST NOT
    // propagate to the caller (the dashboard send path is user-facing).
    expect(() => emitHumanPromptNonBlocking('test-agent')).not.toThrow();

    process.env.CTX_ROOT = realCTXROOT;
  });
});
