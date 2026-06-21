// cortextOS Node.js - Core Type Definitions
// These types match the bash version's JSON formats exactly for backward compatibility

export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export const PRIORITY_MAP: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export const VALID_PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low'];

// Message Bus Types

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  priority: Priority;
  timestamp: string; // ISO 8601
  text: string;
  reply_to: string | null;
  sig?: string; // Security (H10): HMAC-SHA256 signature — optional for backwards compat
}

// Task Types

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';

export interface TaskOutput {
  /** Output kind. "file" links to a saved deliverable; other shapes reserved. */
  type: 'file';
  /** For type:"file", the path to the file relative to CTX_ROOT (forward-slash separated). */
  value: string;
  /** Optional human-readable label shown in dashboard task detail. */
  label?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  type: 'agent' | 'human';
  needs_approval: boolean;
  status: TaskStatus;
  assigned_to: string;
  created_by: string;
  org: string;
  priority: Priority;
  project: string;
  kpi_key: string | null;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  completed_at: string | null;
  due_date: string | null;
  archived: boolean;
  result?: string;
  /** Linked deliverables (files saved via `cortextos bus save-output`). */
  outputs?: TaskOutput[];
  /**
   * Dependency DAG edges (beads-inspired). Optional so existing task
   * files remain valid with these fields absent. `blocked_by` lists
   * task IDs that must reach `completed` before this task can
   * progress; `blocks` is the reverse view, maintained symmetrically
   * at create-time so queries in either direction are cheap.
   */
  blocks?: string[];
  blocked_by?: string[];
}

// Event Types

export type EventCategory =
  | 'action'
  | 'error'
  | 'metric'
  | 'milestone'
  | 'heartbeat'
  | 'message'
  | 'task'
  | 'approval'
  | 'agent_activity'
  | 'routing';

export type EventSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface Event {
  id: string;
  agent: string;
  org: string;
  timestamp: string; // ISO 8601
  category: EventCategory;
  event: string;
  severity: EventSeverity;
  metadata: Record<string, unknown>;
}

// Heartbeat Types

export interface Heartbeat {
  agent: string;
  org: string;
  display_name?: string; // user-configured name from IDENTITY.md (e.g. "Alpha", "Beta")
  status: string;
  current_task: string;
  mode: 'day' | 'night';
  last_heartbeat: string; // ISO 8601
  loop_interval: string;
  // Legacy field — sync.ts falls back to this if last_heartbeat absent
  timestamp?: string;
}

// Approval Types

export type ApprovalCategory =
  | 'external-comms'
  | 'financial'
  | 'deployment'
  | 'data-deletion'
  | 'other';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;
  title: string;
  requesting_agent: string;
  org: string;
  category: ApprovalCategory;
  status: ApprovalStatus;
  description: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

// Agent Config Types (config.json)

export interface EcosystemFeatureConfig {
  enabled?: boolean;
}

export interface EcosystemConfig {
  /** Daily git snapshots of agent workspace. Agent stages safe files, reviews diff, commits. */
  local_version_control?: EcosystemFeatureConfig;
  /** 24h cron to check canonical repo for framework updates. Requires upstream git remote. */
  upstream_sync?: EcosystemFeatureConfig;
  /** Weekly cron to browse community catalog and surface new skills/templates to user. */
  catalog_browse?: EcosystemFeatureConfig;
  /** On-demand workflow to publish custom skills/templates to the community catalog. */
  community_publish?: EcosystemFeatureConfig;
}

export interface AgentConfig {
  startup_delay?: number;
  max_session_seconds?: number;
  max_crashes_per_day?: number;
  /**
   * Sliding-window crash-loop detector. When N crashes occur within the window,
   * the agent auto-pauses (status: 'halted') instead of retrying. Absent = legacy
   * daily counter only.
   */
  crash_window?: { seconds: number; max_crashes?: number };
  model?: string;
  working_directory?: string;
  enabled?: boolean;
  crons?: CronEntry[];
  timezone?: string;
  day_mode_start?: string;
  day_mode_end?: string;
  communication_style?: string;
  approval_rules?: {
    always_ask: string[];
    never_ask: string[];
  };
  ecosystem?: EcosystemConfig;
  /** Context window % at which to warn agent + user. Default: 70. Absent = observe-only. */
  ctx_warning_threshold?: number;
  /** Context window % at which to inject handoff prompt and hard-restart. Default: 80. */
  ctx_handoff_threshold?: number;
  /**
   * Fallback context window cap (tokens) for codex-app-server agents when the
   * server's `thread/tokenUsage/updated` event reports `modelContextWindow=null`.
   * Defaults to 256000 when unset. Only applied to the codex-app-server runtime.
   */
  codex_context_cap?: number;
  /**
   * Agent runtime. Defaults to 'claude-code' when absent.
   * 'hermes' selects the HermesPTY spawn path (Python persistent REPL,
   * NousResearch/hermes-agent) with Hermes-specific bootstrap, session
   * continuity, and exit handling.
   */
  runtime?: 'claude-code' | 'hermes' | 'codex-app-server';
  /**
   * Whether this agent runs a Telegram poller. Defaults to true when absent
   * (preserves existing behaviour). Set to false on specialist agents that
   * should not own a Telegram bot — only the designated orchestrator agent
   * should poll. Requires BOT_TOKEN + CHAT_ID to already be unset or the
   * poller will be skipped regardless.
   */
  telegram_polling?: boolean;
}

export interface CronEntry {
  name: string;
  /** For recurring crons: how often to fire (e.g. "4h", "1d"). */
  interval?: string;
  /** For time-anchored crons: a cron expression (e.g. "0 8 * * *"). Takes precedence over interval. */
  cron?: string;
  /** For one-shot crons: ISO 8601 datetime when the cron should fire. */
  fire_at?: string;
  prompt: string;
  /** "recurring" (default) restores on every session start.
   *  "once" restores only if fire_at is still in the future; deleted after firing. */
  type?: 'recurring' | 'once' | 'disabled';
}

// ---------------------------------------------------------------------------
// External Persistent Cron System — Subtask 1.1
// ---------------------------------------------------------------------------
//
// CronDefinition is the canonical record stored in per-agent crons.json files:
//   .cortextOS/state/agents/{agent_name}/crons.json
//
// The file is an array of CronDefinition objects.  The daemon reads it, schedules
// each enabled cron, and injects the prompt into the agent's PTY on schedule.
//
// Operators may edit crons.json by hand (it is intentionally human-readable).
// Keep all field names lowercase-snake-case and all times as ISO 8601 UTC.
//
// Example records
// ---------------
//
// Heartbeat — every 6 hours (interval shorthand):
// {
//   "name": "heartbeat",
//   "schedule": "6h",
//   "prompt": "Read HEARTBEAT.md and execute the heartbeat workflow.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Periodic health check and status update."
// }
//
// Daily morning briefing — fixed local time via cron expression:
// {
//   "name": "morning-briefing",
//   "schedule": "0 13 * * *",
//   "prompt": "Prepare and send the morning briefing to James.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Daily 09:00 ET briefing (UTC offset applied in schedule).",
//   "last_fired_at": "2026-04-28T13:00:01.042Z",
//   "fire_count": 14
// }
//
// Weekly report — cron expression with day-of-week restriction:
// {
//   "name": "weekly-report",
//   "schedule": "0 16 * * 1",
//   "prompt": "Compile and send the weekly performance report.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Every Monday at 12:00 ET (16:00 UTC).",
//   "fire_count": 3
// }

/**
 * A single persistent cron definition stored in an agent's crons.json.
 *
 * Stored at: `.cortextOS/state/agents/{agent_name}/crons.json`
 *
 * The `schedule` field accepts two formats:
 *   - Interval shorthand: `"6h"`, `"30m"`, `"1d"`, `"2w"`
 *     Parsed by `parseDurationMs()` from `src/bus/cron-state.ts`.
 *   - Standard 5-field cron expression: `"0 8 * * *"`, `"0 0,6,12,18 * * *"` (every 6h)
 *     Evaluated by the daemon scheduler (Subtask 1.3).
 *
 * The daemon fires the cron by injecting `[CRON: {name}] {prompt}` into
 * the agent's PTY session.
 */
export interface CronDefinition {
  // ------------------------------------------------------------------
  // Required fields — must be present for the daemon to schedule this cron.
  // ------------------------------------------------------------------

  /**
   * Unique identifier for this cron within the agent.
   * Used as the key for lookups, updates, and deletions.
   * Must be unique per agent; slugs like "heartbeat" or "morning-briefing" are recommended.
   *
   * @example "heartbeat"
   * @example "morning-briefing"
   */
  name: string;

  /**
   * The prompt text injected into the agent PTY when the cron fires.
   * The daemon prepends `[CRON: {name}] ` automatically for traceability.
   *
   * @example "Read HEARTBEAT.md and execute the heartbeat workflow."
   */
  prompt: string;

  /**
   * When and how often this cron fires.
   *
   * Accepted formats:
   *   - Interval shorthand: `"6h"`, `"30m"`, `"1d"`, `"2w"`
   *     The cron fires every N units after its previous fire (or after daemon start
   *     if it has never fired).
   *   - 5-field cron expression: `"0 8 * * *"`, `"0 0,6,12,18 * * *"`, `"0 16 * * 1"`
   *     Evaluated against the daemon's wall clock (daemon timezone = server timezone).
   *
   * @example "6h"         — every six hours
   * @example "0 13 * * *" — daily at 13:00 UTC
   * @example "0 16 * * 1" — every Monday at 16:00 UTC
   */
  schedule: string;

  /**
   * Whether the daemon should fire this cron.
   * Set to `false` to pause a cron without deleting it.
   *
   * @default true
   */
  enabled: boolean;

  /**
   * ISO 8601 UTC timestamp of when this cron definition was created.
   * Set automatically by `cortextos bus add-cron`; operators should not modify this.
   *
   * @example "2026-04-01T00:00:00.000Z"
   */
  created_at: string;

  // ------------------------------------------------------------------
  // Optional fields — populated at runtime or by operators.
  // ------------------------------------------------------------------

  /**
   * ISO 8601 UTC timestamp of the most recent successful fire.
   * Updated by the daemon scheduler (Subtask 1.3) after each fire.
   * Absent when the cron has never fired.
   *
   * @example "2026-04-28T13:00:01.042Z"
   */
  last_fired_at?: string;

  /**
   * ISO 8601 UTC timestamp set by the scheduler IMMEDIATELY before it awaits
   * the onFire dispatch — i.e. before the agent has acked. On daemon crash
   * mid-fire, this lets `loadCrons` recompute `referenceMs` from the attempt
   * timestamp instead of the stale `last_fired_at`, preventing a double-fire
   * via the catch-up gate. Tradeoff: a fire whose dispatch genuinely failed
   * pre-crash will be skipped one window — preferable to guaranteed re-fire.
   */
  last_fire_attempted_at?: string;

  /**
   * Total number of times this cron has successfully fired.
   * Incremented by the daemon on each successful PTY injection.
   * Absent (or 0) when the cron has never fired.
   */
  fire_count?: number;

  /**
   * ISO 8601 UTC timestamp for one-shot crons — when the cron should fire once
   * and then be deleted. Mutually exclusive with recurring `schedule` semantics:
   * if `fire_at` is set, the daemon treats this as a one-shot regardless of
   * `schedule`. Used by `cron-health.ts` to flag never-fired one-shots that
   * are still inside their grace window as healthy rather than stale.
   *
   * @example "2026-05-15T14:00:00.000Z"
   */
  fire_at?: string;

  /**
   * Human-readable description of what this cron does.
   * Optional — for operator documentation and dashboard display.
   *
   * @example "Periodic health check and status update."
   */
  description?: string;

  /**
   * Arbitrary key-value pairs for agent-specific context.
   * Not interpreted by the daemon; surfaced in dashboard + execution logs.
   *
   * @example { "priority": "high", "source": "/loop" }
   */
  metadata?: Record<string, unknown>;

  /**
   * When true, the Test Fire button in the dashboard is disabled and the
   * IPC fire-cron handler refuses manual-trigger requests.
   *
   * Use this for crons that must only run on their schedule (e.g. crons
   * that do destructive operations or have strict rate-limit contracts).
   *
   * @default false (manual fire is allowed by default — opt-out model)
   */
  manualFireDisabled?: boolean;
}

// ---------------------------------------------------------------------------
// Cron Execution Log — Subtask 1.5
// ---------------------------------------------------------------------------

/**
 * A single entry in the per-agent cron execution log
 * (`$CTX_ROOT/.cortextOS/state/agents/{agent}/cron-execution.log`).
 *
 * The file is JSONL (one JSON object per line, newline-separated).
 * It is append-only; log rotation prunes to the last 1 000 lines.
 *
 * Status semantics:
 *   "fired"   — the fire attempt succeeded on this attempt.
 *   "retried" — this attempt failed but more retries remain (see `error`).
 *   "failed"  — final failure after exhausting all retries (see `error`).
 */
export interface CronExecutionLogEntry {
  /** ISO 8601 UTC timestamp of the fire attempt. */
  ts: string;
  /** Cron name (matches CronDefinition.name). */
  cron: string;
  /** Outcome of this attempt. */
  status: 'fired' | 'retried' | 'failed';
  /** Attempt index (1-based). */
  attempt: number;
  /** Wall-clock duration of the fire attempt in milliseconds. */
  duration_ms: number;
  /** Error message if status is "retried" or "failed"; null otherwise. */
  error: string | null;
}

export interface OrgContext {
  name?: string;
  description?: string;
  industry?: string;
  icp?: string;
  value_prop?: string;
  timezone?: string;
  orchestrator?: string;
  day_mode_start?: string;
  day_mode_end?: string;
  default_approval_categories?: string[];
  communication_style?: string;
  dashboard_url?: string;
  /** When true, agents are instructed at startup that every task submitted
   *  for review must have at least one file deliverable attached via
   *  save-output. The instruction is injected into the boot prompt
   *  dynamically — no agent markdown files are modified. */
  require_deliverables?: boolean;
}

// Telegram Types

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  message_reaction?: TelegramMessageReaction;
}

/**
 * One item in a Telegram message's reaction list. Telegram supports
 * `type: 'emoji'` (standard emoji, the only shape we handle today) and
 * `type: 'custom_emoji'` (premium custom emoji, carrying a `custom_emoji_id`
 * instead of an `emoji` character). Shaped as a tagged union so call sites
 * can narrow safely.
 */
export type TelegramReactionType =
  | { type: 'emoji'; emoji: string }
  | { type: 'custom_emoji'; custom_emoji_id: string };

/**
 * A `message_reaction` update fires when a user adds or removes an
 * emoji reaction on a chat message the bot can see. `old_reaction` and
 * `new_reaction` are the reaction state before/after — empty means "no
 * reaction", so the diff is (new) minus (old). Requires
 * `allowed_updates: ['message_reaction']` in the getUpdates call.
 */
export interface TelegramMessageReaction {
  chat: TelegramChat;
  user?: TelegramUser;
  message_id: number;
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
}

export interface TelegramVoice {
  file_id: string;
  duration: number;
}

export interface TelegramAudio {
  file_id: string;
  duration: number;
  file_name?: string;
}

export interface TelegramVideo {
  file_id: string;
  duration: number;
  file_name?: string;
}

export interface TelegramVideoNote {
  file_id: string;
  duration: number;
}

// Task Management Report Types

export interface StaleTaskReport {
  stale_in_progress: Task[];
  stale_pending: Task[];
  stale_human: Task[];
  overdue: Task[];
}

export interface ArchiveReport {
  archived: number;
  skipped: number;
  dry_run: boolean;
}

// Environment / Context Types

export interface CtxEnv {
  instanceId: string;
  ctxRoot: string;
  frameworkRoot: string;
  agentName: string;
  agentDir: string;
  org: string;
  projectRoot: string;
  timezone?: string;
  orchestrator?: string;
}

// Bus Path Types

export interface BusPaths {
  ctxRoot: string;
  inbox: string;
  inflight: string;
  processed: string;
  logDir: string;
  stateDir: string;
  taskDir: string;
  approvalDir: string;
  analyticsDir: string;
  /**
   * Per-org deliverables root: {ctxRoot}/orgs/{org}/deliverables/.
   * Files saved here are servable by the dashboard's /api/media route because
   * they live under CTX_ROOT.
   */
  deliverablesDir: string;
}

// IPC Types

export type IPCCommandType =
  | 'status'
  | 'start-agent'
  | 'stop-agent'
  | 'restart-agent'
  | 'wake'
  | 'list-agents'
  | 'spawn-worker'
  | 'terminate-worker'
  | 'list-workers'
  | 'inject-worker'
  | 'reload-crons'
  | 'fire-cron'
  | 'inject-agent'
  | 'list-all-crons'
  | 'list-cron-executions'
  | 'add-cron'
  | 'update-cron'
  | 'remove-cron'
  | 'fleet-health';

// ---------------------------------------------------------------------------
// Execution log pagination response — Subtask 4.3
// ---------------------------------------------------------------------------

/**
 * Paginated response for list-cron-executions IPC command.
 */
export interface CronExecutionLogPage {
  entries: CronExecutionLogEntry[];
  /** Total matching entries (after cronName + statusFilter applied). */
  total: number;
  /** True when there are more entries older than this page. */
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// list-all-crons response shape — Subtask 4.1
// ---------------------------------------------------------------------------

/**
 * One row returned by the `list-all-crons` IPC command.
 * Combines the cron definition with runtime state (last fire, next fire, status).
 */
export interface CronSummaryRow {
  /** Agent that owns this cron. */
  agent: string;
  /** Org the agent belongs to (from enabled-agents.json). */
  org: string;
  /** Full cron definition as stored in crons.json. */
  cron: CronDefinition;
  /**
   * ISO 8601 timestamp of the most recent fire attempt.
   * Null when the cron has never fired (no execution log entry).
   */
  lastFire: string | null;
  /**
   * Outcome of the most recent execution log entry.
   * Null when the cron has never fired.
   */
  lastStatus: 'fired' | 'retried' | 'failed' | null;
  /**
   * ISO 8601 timestamp of the next scheduled fire.
   * Computed from the cron's schedule + last_fired_at (or now).
   */
  nextFire: string;
}

// ---------------------------------------------------------------------------
// Fleet Health — Subtask 4.4
// ---------------------------------------------------------------------------

export type CronHealthState = 'healthy' | 'warning' | 'failure' | 'never-fired';

/** Health record for a single cron, returned by the fleet-health IPC command. */
export interface CronHealthRow {
  agent: string;
  org: string;
  cronName: string;
  state: CronHealthState;
  reason: string;
  lastFire: number | null;
  expectedIntervalMs: number;
  gapMs: number | null;
  successRate24h: number;
  firesLast24h: number;
  nextFire: string;
}

/** Per-agent breakdown in the fleet-health summary. */
export interface AgentHealthSummary {
  agent: string;
  org: string;
  total: number;
  healthy: number;
  warning: number;
  failure: number;
  neverFired: number;
}

/** Full response returned by the fleet-health IPC command. */
export interface FleetHealthResponse {
  rows: CronHealthRow[];
  summary: {
    total: number;
    healthy: number;
    warning: number;
    failure: number;
    neverFired: number;
    agents: Record<string, AgentHealthSummary>;
  };
}

export interface IPCRequest {
  type: IPCCommandType;
  agent?: string;
  data?: Record<string, unknown>;
  /**
   * BUG-015: human-readable identifier of the caller (e.g. 'cortextos enable',
   * 'cortextos bus soft-restart-all'). Logged by the daemon on every incoming
   * IPC request so we can trace which CLI command triggered which daemon action.
   * Optional for backwards compatibility — older clients fall back to 'unknown'.
   */
  source?: string;
}

// Worker Types

export type WorkerStatusValue = 'starting' | 'running' | 'completed' | 'failed';

export interface WorkerStatus {
  name: string;
  status: WorkerStatusValue;
  pid?: number;
  dir: string;
  parent?: string;
  spawnedAt: string;
  exitCode?: number;
}

export interface IPCResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  /**
   * Structured error code for failed responses. Lets operators distinguish
   * "agent does not exist" (NOT_FOUND) from "request collapsed against an
   * in-flight identical op" (DEDUPED). See issue #346.
   */
  code?: 'NOT_FOUND' | 'DEDUPED' | 'INVALID_INPUT' | 'NOT_RUNNING';
}

// Agent Discovery Types

export interface AgentInfo {
  name: string;
  org: string;
  display_name?: string;  // user-configured name from IDENTITY.md (e.g. "Alpha", "Beta")
  role: string;
  enabled: boolean;
  running: boolean;
  last_heartbeat: string | null;
  current_task: string | null;
  mode: string | null;
}

// Agent Status (returned by daemon)

export interface AgentStatus {
  name: string;
  status: 'running' | 'stopped' | 'crashed' | 'starting' | 'halted';
  pid?: number;
  uptime?: number; // seconds
  lastHeartbeat?: string;
  sessionStart?: string;
  crashCount?: number;
  model?: string;
}

// ---------------------------------------------------------------------------
// D24 Runtime-Boundary Protocol — Four-Type Contract
// ---------------------------------------------------------------------------
// These types define the uniform protocol every runtime adapter must emit.
// See: .planning/cortextos-native-integration-strategy.md §D24
//
// `Runtime` is a superset of `Platform` ('claude' | 'codex') in
// src/routing/types.ts — Platform remains the P2a bandit-routing discriminant;
// Runtime is the finer-grained adapter identity used at spawn time and in
// RuntimeDriver implementations.

/**
 * Identifies which runtime adapter produced an observation or owns a run.
 * Superset of Platform ('claude' | 'codex') from src/routing/types.ts.
 * Do NOT redefine or merge Platform — they serve different layers.
 */
export type Runtime =
  | 'claude-bg'
  | 'codex-app-server'
  | 'codex-exec'
  | 'hermes'
  | 'workflow-observer'
  | 'claude-discovery';

/**
 * How well a runtime supports a particular capability.
 * 'native'   — first-class platform support, no workarounds
 * 'emulated' — achievable via cortextOS shims but not platform-native
 * 'degraded' — partial; may lose fidelity or require polling
 * 'none'     — capability is absent; callers must not rely on it
 * 'unknown'  — adapter has not been probed yet
 */
export type CapabilityGrade = 'native' | 'emulated' | 'degraded' | 'none' | 'unknown';

/** How well this runtime can observe what a run is doing. */
export interface ObserveCapabilities {
  /** Per-turn output visibility. */
  process: CapabilityGrade;
  /** Individual turn start/end events. */
  turn: CapabilityGrade;
  /** Tool-call observation granularity. */
  tool: CapabilityGrade;
  /** Visibility into nested subagent/workflow descendants. */
  descendants: CapabilityGrade;
  /** Token + cost accounting fidelity. */
  cost: CapabilityGrade;
}

/** How well this runtime can steer or stop a run that is already active. */
export interface ControlCapabilities {
  /** Inject a new turn into an active run. */
  submitTurn: CapabilityGrade;
  /** Modify a turn that is currently being executed. */
  steerActiveTurn: CapabilityGrade;
  /** Cancel the current turn without terminating the run. */
  interruptTurn: CapabilityGrade;
  /** Fully stop the run (process + session). */
  terminateRun: CapabilityGrade;
  /** Drain in-flight work before shutdown. */
  drain: CapabilityGrade;
}

/** How well this runtime can recover from failures or handoff a run. */
export interface RecoveryCapabilities {
  /** Reopen an existing conversation from a prior session. */
  resumeConversation: CapabilityGrade;
  /** Attach to a process that outlived the daemon (e.g. after crash). */
  reattachLiveProcess: CapabilityGrade;
  /** Roll back file-system state to a checkpoint. */
  rewindFiles: CapabilityGrade;
  /** Claim a run whose prior holder died without finishing. */
  adoptOrphan: CapabilityGrade;
}

/** File-system and process isolation guarantees for runs under this runtime. */
export interface IsolationCapabilities {
  /**
   * Isolation root for each run.
   * 'none'           — all runs share the same cwd
   * 'cwd'            — each run gets a unique working directory
   * 'worktree'       — each run is a separate git worktree
   * 'container'      — each run runs in an isolated container
   */
  root: 'none' | 'cwd' | 'worktree' | 'container';
  /**
   * How descendant (nested) runs share isolation scope.
   * 'shared'          — descendants inherit the parent's root
   * 'worktree'        — each descendant gets its own worktree
   * 'runtime-defined' — the runtime decides per-descendant
   */
  descendants: 'shared' | 'worktree' | 'runtime-defined';
}

/** Aggregated capability envelope for a runtime adapter. */
export interface RuntimeCapabilities {
  observe: ObserveCapabilities;
  control: ControlCapabilities;
  recovery: RecoveryCapabilities;
  isolation: IsolationCapabilities;
}

/**
 * Per-capability metadata attachable to a runtime driver entry.
 * Describes latency, transport, durability, and billing properties.
 */
export interface CapabilityMetadata {
  /** Temporal scope of the capability: which grain does it apply to? */
  scope: 'session' | 'turn' | 'task' | 'child' | 'workflow';
  /** Human-readable latency estimate for control operations (e.g. "~200ms"). */
  controlLatency?: string;
  /** Delivery guarantee for control signals (e.g. "at-most-once"). */
  controlGuarantee?: string;
  /** How event data reaches the daemon. */
  eventTransport: 'push' | 'poll' | 'inferred';
  /** Persistence guarantee for events (e.g. "write-ahead log, 7d retention"). */
  durability?: string;
  /** How stale the reported state can be (e.g. "≤30s polling lag"). */
  freshness?: string;
  /** Runtime adapter version string for diagnostics. */
  runtimeVersion?: string;
  /** Maximum runs this adapter can manage in parallel. */
  maxConcurrency?: number;
  /**
   * Whether budgets are enforced by the platform natively or by cortextOS.
   * 'native'    — platform tracks and enforces; cortextOS observes only
   * 'cortextos' — cortextOS injects limits at dispatch; platform is unaware
   */
  budgetOrigin: 'native' | 'cortextos';
  /** Auth/billing mode string for diagnostics (e.g. "oauth-subscription"). */
  authBillingMode?: string;
}

/**
 * Which billing pool a run draws from.
 * Required on RunSpec and RunStatus so N4 can enforce cross-pool budget limits.
 */
export type BillingPool = 'subscription' | 'metered' | 'unknown';

/**
 * Fencing token — opaque string issued to the current run holder.
 * A new epoch mints a new token; stale holders are rejected on heartbeat.
 */
export type FencingToken = string;

/**
 * Monotonically increasing ownership epoch for a worktree/run slot.
 * Bumped every time ownership transfers; used to detect stale holders.
 */
export type OwnershipEpoch = number;

/**
 * Lease record held by the active owner of a worktree or run slot.
 * Holders must refresh `heartbeat` at least every epoch window or lose the lease.
 */
export interface RunLease {
  /** Absolute path to the worktree this lease covers. */
  worktree: string;
  /** run_id of the holder that acquired this lease. */
  holderRunId: string;
  /** Fencing token — changes on each epoch transition. */
  fencingToken: FencingToken;
  /** Epoch counter at acquisition time. */
  epoch: OwnershipEpoch;
  /** ISO-8601 timestamp of the most recent heartbeat from the holder. */
  heartbeat: string; // ISO-8601
}

/**
 * Desired, immutable specification for a single run.
 * Created once at dispatch time; never mutated after creation.
 *
 * Budget fields (`budget_tokens`, `budget_cost_usd`) are required so N4
 * can enforce cross-pool spending limits before the run consumes resources.
 */
export interface RunSpec {
  /** Globally unique run identifier (UUIDv4 recommended). */
  run_id: string;
  /** run_id of the parent run that spawned this one, if any. */
  parent_run_id?: string;
  /** Runtime adapter that will execute this run. */
  runtime: Runtime;
  /** Model identifier to use (e.g. "claude-opus-4-5", "gpt-4o"). */
  model: string;
  /** Absolute working directory for the run's file operations. */
  cwd: string;
  /** Worktree path when isolation.root === 'worktree'. */
  worktree?: string;
  /** ISO-8601 deadline after which the run must be stopped. */
  deadline?: string; // ISO-8601
  /** Client-supplied key preventing duplicate dispatches on retry. */
  idempotency_key: string;
  /** Tool-call categories that require a human approval gate before proceeding. */
  approval_boundaries?: string[];
  /** Reference to a verification contract the run must satisfy before completion. */
  verification_contract?: string;
  /**
   * Billing pool this run draws from.
   * Required so N4 can enforce cross-pool budget limits.
   */
  billing_pool: BillingPool;
  /**
   * Maximum tokens this run may consume (input + output).
   * Required so N4 can enforce cross-pool budget limits.
   */
  budget_tokens?: number;
  /**
   * Maximum USD cost this run may incur.
   * Required so N4 can enforce cross-pool budget limits.
   */
  budget_cost_usd?: number;
}

/**
 * Observed, mutable state snapshot for a run.
 * Updated as the run progresses; never replaces RunSpec.
 */
export interface RunStatus {
  /** Matches RunSpec.run_id. */
  run_id: string;
  /** Current lifecycle state of the run. */
  state: 'working' | 'blocked' | 'done' | 'failed' | 'stopped';
  /** Human-readable label for the current phase (e.g. "planning", "executing"). */
  phase?: string;
  /** Total tokens consumed so far (input + output). */
  tokens?: number;
  /** Total cost incurred so far (USD). */
  cost?: number;
  /** Billing pool this run is drawing from. */
  billing_pool: BillingPool;
  /** ISO-8601 timestamp of the most recent heartbeat from the run. */
  heartbeat: string; // ISO-8601
  /** Remaining token budget (if budget_tokens was specified in RunSpec). */
  budget_remaining_tokens?: number;
  /** Remaining cost budget in USD (if budget_cost_usd was specified in RunSpec). */
  budget_remaining_cost_usd?: number;
  /** Active worktree lease, present when the run holds an exclusive lease. */
  lease?: RunLease;
  /** Ownership epoch at the time this snapshot was taken. */
  ownership_epoch?: OwnershipEpoch;
}

/** Discriminant for runtime event payloads. */
export type RuntimeEventKind = 'turn' | 'tool-call' | 'artifact' | 'lifecycle';

/**
 * A single append-only evidence record emitted by a runtime adapter.
 * Every adapter must produce RuntimeEvents on the bus so the daemon can
 * observe runs without polling each runtime directly.
 *
 * Designed append-only — existing events must never be mutated.
 * `session_id` is the native run correlation key (e.g. claude session UUID).
 */
export interface RuntimeEvent {
  /** Category of the event. */
  kind: RuntimeEventKind;
  /** run_id from the originating RunSpec. */
  run_id: string;
  /** Native session/run correlation key from the platform. */
  session_id: string;
  /** ISO-8601 timestamp when the event occurred. */
  timestamp: string; // ISO-8601
  /** Arbitrary event-specific data. Callers must not rely on shape. */
  payload: Record<string, unknown>;
}

/**
 * Uniform adapter interface every runtime driver must implement.
 * The daemon calls these methods; adapters translate to platform-specific APIs.
 */
export interface RuntimeDriver {
  /** Adapter's own runtime identifier. */
  runtime: Runtime;
  /** Self-reported capability envelope. */
  capabilities: RuntimeCapabilities;
  /** Dispatch a new run per the given spec. Resolves when the run is accepted. */
  dispatch(spec: RunSpec): Promise<void>;
  /** Fetch the current status snapshot for a run, or null if not found. */
  getStatus(run_id: string): Promise<RunStatus | null>;
  /** List all runs this adapter is currently managing. */
  listRuns(): Promise<RunStatus[]>;
  /**
   * Parse raw output from `claude agents list --json` (or equivalent)
   * into a RunStatus. Each adapter supplies its own shape mapping.
   */
  parseAgentsJson(raw: unknown): RunStatus;
  /**
   * Parse a raw hook-event payload from the platform (e.g. claude Code hook
   * or Codex event) into a RuntimeEvent.
   */
  parseHookEvent(raw: unknown): RuntimeEvent;
}
