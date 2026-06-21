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

🔴 **Memory gotcha — `next dev` must run in webpack mode (caused a 90GB OOM hard-restart, 2026-06-21).**
This app is Next 16, whose `next dev` default is **Turbopack**. Two compounding causes exhausted
system RAM and forced a hard restart (confidence levels noted — the OOM itself was not captured
under instrumentation, only reproduced afterward):

1. **Turbopack dev is a runaway here (strongly evidenced).** A cold compile drove **~9GB of
   system-memory pressure (free+inactive dropped 12GB→2.6GB) across ~600 processes in ~21s** and
   never served a response (`/login` hung at HTTP `000`). The Node heap cap (`--max-old-space-size`)
   does **not** bound it — Turbopack's memory is native/Rust, outside V8. (Caveats: the per-process
   memory attribution used summed RSS / free-mem delta, which overstate; the authoritative signal
   is the system-pressure correlation + the never-responds hang. Measured 2026-06-21.)
2. **VS Code's file-watcher almost certainly amplified it (inferred, not captured).** Activity
   Monitor showed VS Code at ~90GB during the original incident; the mechanism is its watcher on
   the 554MB `.next` cache Turbopack rewrote in a loop, since default VS Code `watcherExclude` does
   not cover `.next`. Fixed by the workspace `.vscode/settings.json`. Post-fix, VS Code RSS stayed
   flat at ~3–4GB during a dev run — consistent with the watcher being the amplifier, though the
   90GB peak itself was never reproduced under instrumentation.

**Webpack mode is bounded and is now the default `dev` script** — 1.9GB peak, 3 processes,
responsive (`/login` → `200`), flat over a 6-min run:

```bash
npm run dev -- --hostname 127.0.0.1            # = `next dev --webpack` (safe default)
```

🔴 **Do NOT use `npm run dev:turbopack`** (the bare `next dev` Turbopack path) for local dev until
the Turbopack memory explosion is root-caused — it is the script that triggered the 90GB crash.

The chokidar watcher (`src/lib/watcher.ts`) only watches `CTX_ROOT/{state,inbox,orgs}` (tiny);
the SQLite DB lives at `CTX_ROOT/dashboard/*.db` — **outside** every watched path, so WAL churn
never feeds the watcher (no watch→write loop). Keep it that way. The workspace
`.vscode/settings.json` exclusions must stay in place — a VS Code reload is required for changes
there to take effect.

## Dashboard codex coverage

The dashboard renders `runtime: codex-app-server` agents identically to claude agents. The two surfaces that needed codex-aware logic (PR-08) are:

- **Cost view** — `dashboard/src/lib/cost-parser.ts` walks both `~/.claude/projects/*.jsonl` (claude transcripts) and `<ctxRoot>/logs/<agent>/codex-tokens.jsonl` (codex per-turn flat-schema log), then merges into a single `CostEntry[]` keyed by `source_file` for dedup. `gpt-5-codex` pricing is in `MODEL_PRICING` ($1.25/M input, $10/M output, $0.125/M cache_read, $0/M cache_write) with substring matching on `codex` or `gpt-5` in `resolvePricingKey()`.
- **Fleet health view** — `computeFleetHealth` in `src/daemon/ipc-server.ts` is fully runtime-agnostic; codex agents appear in the fleet summary and cron table with the same row shape and state machine as claude agents. The runtime badge is set from `config.json.runtime`.

The codex-only test peer at `dashboard/src/lib/__tests__/cost-parser-codex.test.ts` is the mutation gate: deliberately break codex pricing in `cost-parser.ts` and this suite must fail. Run `npm run test:codex` from the repo root to execute it alongside the integration peers (`tests/integration/fleet-health-mixed-codex-claude.test.ts`, `tests/integration/codex-bus-roundtrip.test.ts`, etc.).
