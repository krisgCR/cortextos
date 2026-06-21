/**
 * Capability scaffolding for runtime adapters.
 *
 * `makeCapabilities` builds a RuntimeCapabilities envelope with safe defaults
 * (every CapabilityGrade defaults to 'unknown'; isolation defaults to shared/none).
 * Adapters call this with only the fields they actually know; unknowns stay unknown.
 *
 * `DEFAULT_CAPABILITY_METADATA` supplies default CapabilityMetadata for fields
 * that adapters commonly leave unset.
 */

import type {
  CapabilityGrade,
  CapabilityMetadata,
  ControlCapabilities,
  IsolationCapabilities,
  ObserveCapabilities,
  RecoveryCapabilities,
  RuntimeCapabilities,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Internal helpers — build each sub-capability with 'unknown' defaults
// ---------------------------------------------------------------------------

function defaultObserve(): ObserveCapabilities {
  const g: CapabilityGrade = 'unknown';
  return {
    process: g,
    turn: g,
    tool: g,
    descendants: g,
    cost: g,
  };
}

function defaultControl(): ControlCapabilities {
  const g: CapabilityGrade = 'unknown';
  return {
    submitTurn: g,
    steerActiveTurn: g,
    interruptTurn: g,
    terminateRun: g,
    drain: g,
  };
}

function defaultRecovery(): RecoveryCapabilities {
  const g: CapabilityGrade = 'unknown';
  return {
    resumeConversation: g,
    reattachLiveProcess: g,
    rewindFiles: g,
    adoptOrphan: g,
  };
}

function defaultIsolation(): IsolationCapabilities {
  return {
    root: 'none',
    descendants: 'shared',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a RuntimeCapabilities envelope with 'unknown' defaults everywhere.
 *
 * Adapters supply only the sub-fields they have determined; the rest remain
 * 'unknown' so callers can distinguish "not supported" from "not yet probed".
 *
 * ```ts
 * // Claude-bg adapter — knows observe.process is native, everything else unknown
 * const caps = makeCapabilities({
 *   observe: { ...makeCapabilities().observe, process: 'native' },
 * });
 * ```
 */
export function makeCapabilities(
  overrides?: Partial<RuntimeCapabilities>,
): RuntimeCapabilities {
  const base: RuntimeCapabilities = {
    observe: defaultObserve(),
    control: defaultControl(),
    recovery: defaultRecovery(),
    isolation: defaultIsolation(),
  };

  if (!overrides) {
    return base;
  }

  return {
    observe: overrides.observe ?? base.observe,
    control: overrides.control ?? base.control,
    recovery: overrides.recovery ?? base.recovery,
    isolation: overrides.isolation ?? base.isolation,
  };
}

/**
 * Default per-capability metadata.
 *
 * Adapters extend or override this for their specific transport, durability,
 * and billing characteristics.
 */
export const DEFAULT_CAPABILITY_METADATA: CapabilityMetadata = {
  scope: 'task',
  eventTransport: 'inferred',
  budgetOrigin: 'cortextos',
};
