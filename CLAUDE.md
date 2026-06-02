# Contributing to cortextOS

> This is a **customized fork** of `grandamenium/cortextos`, adapted for a single-overseer
> autonomous fleet. Some upstream behaviors are deliberately changed — see the decisions below.
> Authoritative record: `.planning/cortextos-overseer-fork-roadmap.md` (§2 decisions D1–D21) and
> `.planning/cortextos-overseer-decision-journal.md`.

## Fork Architecture Decisions

- 🔴 **Telegram is DROPPED — the dashboard is the sole control plane (D5).** This fork does
  **not** use Telegram for remote control. Do not build on, "fix," or wire up the Telegram path;
  agents run with `telegram_polling: false` (or empty `BOT_TOKEN`/`CHAT_ID`). Remote control is
  the Tailscale-reachable, auth-gated Next.js dashboard (approvals + compose bar), which removes
  the bot-token injection surface. Native Claude remote control was also rejected — it doesn't fit
  daemon-spawned PTY agents (D6).
  - **Consequence — inherited templates are stale on this point.** The upstream agent templates
    (`templates/*/CLAUDE.md`, `AGENTS.md`, the `onboarding` skill) still reference Telegram boot
    messages, `send-telegram`, and `BOT_TOKEN`/`CHAT_ID` setup. Those instructions are **not the
    fork's path** — treat them as legacy. Agent onboarding that requires "connect a Telegram bot"
    is deferred with the dashboard-comms work, not a prerequisite to running an agent.
- **Control plane is local-loopback bind + Tailscale Serve (P0/P1).** The dashboard binds
  `127.0.0.1:3000`; phone reachability is via `tailscale serve` (Funnel OFF, tailnet-only).
  Never `next dev`, `0.0.0.0`, or plain HTTP — see `.planning/p1-tailscale-serve-runbook.md`.

## Development Setup

```bash
git clone https://github.com/grandamenium/cortextos.git
cd cortextos
npm install
npm run build
npm test
```

## Before Submitting Changes

1. `npm run build` — TypeScript must compile cleanly
2. `npm test` — all tests must pass
3. Match existing patterns in `src/` for new features
4. Add unit tests in `tests/` for any new code

## Project Structure

- `src/` — TypeScript source (bus, cli, daemon, hooks, types, utils)
- `bus/` — Shell wrapper scripts (delegate to `dist/cli.js bus`)
- `dashboard/` — Next.js 14 web dashboard
- `templates/` — Agent templates (agent, orchestrator, analyst)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Git

- 🔴 **Never push to `upstream`** (`grandamenium/cortextos`). Push only to `origin` (`krisgCR/cortextos`, the fork). `upstream` is fetch-only — never `git push upstream`, and never target it when pushing branches, tags, or `main`.

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules
