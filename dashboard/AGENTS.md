@../AGENTS.md

---

# Dashboard (cortextOS control plane)

Next.js 14 app — the **sole** remote control plane for the fleet (auth-gated via NextAuth,
reachable over Tailscale). Renders fleet health, cost, activity, approvals, and a compose bar.

## Commands (run from `dashboard/`)

```bash
npm run dev -- --hostname 127.0.0.1   # dev server, loopback-only (see bind gotcha)
npm run build                          # next build
npm run start                          # next start (production)
npm run lint                           # eslint
npm test                               # vitest run --root .. dashboard/src
npm run test:codex                     # codex cost-parser mutation gate
```

🔴 **Bind gotcha:** `next dev`/`next start` ignore the `HOSTNAME` env var and bind `0.0.0.0`.
You **must** pass `--hostname 127.0.0.1` on the CLI for the loopback-only control plane. Never
bind `0.0.0.0` or serve plain HTTP. Phone reachability is `tailscale serve` (Funnel OFF,
tailnet-only) — see `.planning/p1-tailscale-serve-runbook.md`.

## Dashboard codex coverage

The dashboard renders `runtime: codex-app-server` agents identically to claude agents. The two surfaces that needed codex-aware logic (PR-08) are:

- **Cost view** — `dashboard/src/lib/cost-parser.ts` walks both `~/.claude/projects/*.jsonl` (claude transcripts) and `<ctxRoot>/logs/<agent>/codex-tokens.jsonl` (codex per-turn flat-schema log), then merges into a single `CostEntry[]` keyed by `source_file` for dedup. `gpt-5-codex` pricing is in `MODEL_PRICING` ($1.25/M input, $10/M output, $0.125/M cache_read, $0/M cache_write) with substring matching on `codex` or `gpt-5` in `resolvePricingKey()`.
- **Fleet health view** — `computeFleetHealth` in `src/daemon/ipc-server.ts` is fully runtime-agnostic; codex agents appear in the fleet summary and cron table with the same row shape and state machine as claude agents. The runtime badge is set from `config.json.runtime`.

The codex-only test peer at `dashboard/src/lib/__tests__/cost-parser-codex.test.ts` is the mutation gate: deliberately break codex pricing in `cost-parser.ts` and this suite must fail. Run `npm run test:codex` from the repo root to execute it alongside the integration peers (`tests/integration/fleet-health-mixed-codex-claude.test.ts`, `tests/integration/codex-bus-roundtrip.test.ts`, etc.).
