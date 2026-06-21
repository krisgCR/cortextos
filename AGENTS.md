# AGENTS.md — cortextOS

cortextOS is a daemon-based multi-agent orchestration system (TypeScript daemon + CLI, with a
Next.js dashboard). Persistent agents run as PTY sessions under a PM2-managed daemon with
auto-restart and crash recovery.

> This is a **customized fork** of `grandamenium/cortextos`, adapted for a single-overseer
> autonomous fleet. Some upstream behaviors are deliberately changed — see **Fork Decisions**
> below. Authoritative record: `.planning/cortextos-overseer-fork-roadmap.md` (§2 decisions
> **D1–D25**) and `.planning/cortextos-overseer-decision-journal.md`.
>
> 🔵 **Read `.planning/cortextos-native-integration-strategy.md` first** — it defines **the Seam (D22–D25, 2026-06-13)**: this fork owns the FLEET (cross-model runtimes, dashboard, human gates, policy/router, bus); **Anthropic native owns WITHIN-agent orchestration** (Dynamic Workflows, nested subagents, worktree isolation) used *inside* our agents, and **Claude session supervision is delegated to native `claude agents`** (D23). Don't hand-build orchestration/supervision the platform now ships. **Phase N** (roadmap §7) is underway: **N1** (native API validated), **N1.5** (subscription billing confirmed) and **N2** (runtime-boundary protocol — `src/runtime/`) are landed; **N3 (dashboard federation) is next**.

This file is the source of truth for agents working **on this repo**. `CLAUDE.md` imports it.

## Setup & Commands

Requires **Node ≥ 20**. No external runtime deps beyond `package.json` (`node-pty`, `chokidar`,
`commander`, `chalk`, `ora`, `strip-ansi`, `@inquirer/prompts`).

```bash
npm install
npm run build          # tsup → dist/ (TypeScript must compile cleanly before any PR)
npm test               # vitest run — unit + integration
npm run test:codex     # codex-specific lifecycle/integration suites
npm run typecheck      # tsc --noEmit  (lint is the same: tsc --noEmit)
npm run test:playwright # e2e (Playwright)
```

**Dashboard** (separate workspace, see `dashboard/AGENTS.md`):

```bash
cd dashboard
npm run dev -- --hostname 127.0.0.1   # see bind gotcha below
npm run build && npm run start
npm test                              # vitest run --root .. dashboard/src
```

🔴 **Dashboard bind gotcha:** `next dev`/`next start` **ignore** the `HOSTNAME` env var and bind
`0.0.0.0`. For the loopback-only control plane you **must** pass `--hostname 127.0.0.1` on the
CLI. Never bind `0.0.0.0` or serve plain HTTP; phone reachability is via `tailscale serve`
(Funnel OFF, tailnet-only). See `.planning/p1-tailscale-serve-runbook.md`.

## Project Structure

- `src/bus/` — HMAC-signed file bus (agents, tasks, events, heartbeat, messages, approvals, crons)
- `src/cli/` — CLI commands (`add-agent`, `init`, `install`, `start`, `stop`, `dashboard`, …)
- `src/daemon/` — daemon core: `agent-manager`, `worker-process`, `ipc-server`
- `src/pty/` — PTY wrappers: `agent-pty` (Claude), `codex-app-server-pty` & `codex-worker-pty` (Codex)
- `src/routing/` — **P2a** model-routing layer (complexity buckets, tier bandit, runtime dispatch)
- `src/types/index.ts` — **canonical** shared types; change types here, not at call sites
- `src/hooks/`, `src/utils/` — hook helpers; utils incl. `atomic.ts` (atomic writes), paths, validate
- `src/telegram/` — **legacy/dead in this fork** (see D5); do not build on it
- `bus/` — shell wrappers that delegate to `dist/cli.js bus`
- `dashboard/` — Next.js 14 control plane (auth-gated, Tailscale-reachable)
- `templates/` — agent scaffolding (`agent/`, `agent-codex/`, `orchestrator/`, `analyst/`, …)
- `community/` — public, intentionally-generic skill & agent catalog
- `tests/` — `unit/`, `integration/`, `e2e/`
- `orgs/` — **gitignored** runtime agent instances (scaffolded from `templates/`)
- `.planning/` — **gitignored** internal fork planning docs

## Fork Decisions (constrain what you change)

- 🔵 **The Seam — fleet vs. task (D22–D25).** cortextOS owns the **fleet**; **Anthropic native owns within-agent orchestration.** Concretely: (1) **don't hand-build** decompose/fan-out/verify/loop machinery — that's **Dynamic Workflows + nested subagents** run *inside* a supervised agent; (2) **don't build Claude PTY supervision** — dispatch/enumerate/stop Claude sessions via native **`claude agents`** (`--json` is scriptable, no TTY) (D23); (3) **don't build worktree-per-task cages** — use native `isolation:'worktree'`; (4) **DO build/keep:** the cross-model adapters (`src/pty/` Codex/Hermes — Agent View is Claude-only), the **runtime-boundary protocol** (D24, the spine — uniform `RuntimeBoundaryRecord` every adapter emits), the federated dashboard, the bandit router, the HMAC bus, and **aggregate budget/cancel at the dispatch boundary** (D25). The HMAC bus stays for **cross-model** peer comms (Agent Teams rejected — Claude-only). Native runs are **bounded atomic units**, observable via `~/.claude/projects/<session>/subagents/workflows/<runId>/`. Verified by spike 2026-06-13.
- 🔴 **Telegram is DROPPED — the dashboard is the sole control plane (D5).** Do not build on,
  "fix," or wire up Telegram for remote control; agents run with `telegram_polling: false`.
  Remote control is the auth-gated, Tailscale-reachable dashboard (approvals + compose bar).
  Native Claude remote control was also rejected — it doesn't fit daemon-spawned PTY agents (D6).
  - **Inherited agent templates are stale on this point.** `templates/*/AGENTS.md`, the
    `onboarding` skill, etc. still reference Telegram boot messages and `send-telegram`. Those
    are **legacy**, kept working until dashboard-comms ships — not the fork's intended path.
- **Control plane = local-loopback bind + Tailscale Serve (P0/P1).** Dashboard binds
  `127.0.0.1:3000`; phone reach via `tailscale serve` (Funnel OFF). Never `0.0.0.0` or plain HTTP.
- **P2a model routing is observe-only.** `src/routing/` is gated behind `CTX_ROUTING_CALIBRATION`
  (default off) and selects models at spawn time only; the bandit does **not** learn yet (reward
  signal lands in P3). Don't describe it as calibrating/learning.

## Code Style

- TypeScript **strict mode**; explicit types, no `any`.
- No new runtime dependencies beyond `package.json`.
- File mutations use atomic writes — see `src/utils/atomic.ts`.
- All bus operations go through `src/bus/` modules.
- Match existing patterns in `src/` for new features.

## Git

- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:` — subject line only.
- 🔴 **Never push to `upstream`** (`grandamenium/cortextos`, fetch-only). Push only to `origin`
  (`krisgCR/cortextos`). Never target `upstream` for branches, tags, or `main`.
- Prefer `git rebase origin/main` over `git merge main` on feature branches.
- Force-push with `--force-with-lease`, never `--force`. Never `git filter-branch`.

## Before Submitting

1. `npm run build` — TypeScript compiles cleanly.
2. `npm test` — all tests pass.
3. Add unit tests in `tests/` for new code; match existing patterns in `src/`.
