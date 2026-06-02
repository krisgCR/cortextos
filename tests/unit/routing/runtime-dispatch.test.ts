import { describe, it, expect } from 'vitest';
import { classifyRuntime } from '../../../src/routing/runtime-dispatch';
import { TIER_MODEL_MAP } from '../../../src/routing';

describe('classifyRuntime', () => {
  it('returns claude for interactive/reasoning tasks', () => {
    const result = classifyRuntime('implement the new auth feature');
    expect(result.platform).toBe('claude');
    expect(result.reason).toBeTruthy();
    expect(result.spawnArgs).toEqual({});
  });

  it('returns claude by default for unrecognized text', () => {
    expect(classifyRuntime('do the thing').platform).toBe('claude');
    expect(classifyRuntime('').platform).toBe('claude');
    expect(classifyRuntime('research best practices').platform).toBe('claude');
  });

  it('returns codex for batch/headless tasks', () => {
    expect(classifyRuntime('batch process all log files').platform).toBe('codex');
    expect(classifyRuntime('headless scan of the repository').platform).toBe('codex');
    expect(classifyRuntime('run a parallel sweep').platform).toBe('codex');
    expect(classifyRuntime('bulk update all records').platform).toBe('codex');
    expect(classifyRuntime('extract data from CSV files').platform).toBe('codex');
  });

  it('includes {{PROMPT}} template slot in codex spawnArgs', () => {
    const result = classifyRuntime('batch transform these files');
    expect(result.platform).toBe('codex');
    expect(result.spawnArgs['prompt']).toBe('{{PROMPT}}');
  });

  it('codex classification includes documented spawnArgs keys', () => {
    const result = classifyRuntime('aggregate and index all logs');
    expect(result.platform).toBe('codex');
    expect(Object.keys(result.spawnArgs)).toContain('prompt');
  });
});

describe('TIER_MODEL_MAP', () => {
  const TIERS = ['haiku', 'sonnet', 'opus'] as const;

  it('resolves every tier to a platform and model', () => {
    for (const tier of TIERS) {
      const resolved = TIER_MODEL_MAP[tier];
      expect(resolved).toBeDefined();
      expect(['claude', 'codex']).toContain(resolved.platform);
      expect(typeof resolved.model).toBe('string');
      expect(resolved.model.length).toBeGreaterThan(0);
    }
  });

  it('haiku tier resolves to a haiku model string', () => {
    expect(TIER_MODEL_MAP.haiku.model).toContain('haiku');
  });

  it('sonnet tier resolves to a sonnet model string', () => {
    expect(TIER_MODEL_MAP.sonnet.model).toContain('sonnet');
  });

  it('opus tier resolves to an opus model string', () => {
    expect(TIER_MODEL_MAP.opus.model).toContain('opus');
  });
});
