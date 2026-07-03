---
name: e2e-fleet
description: >
  Live two-layer end-to-end verification of cortextOS — boots an ISOLATED, ZERO-BILL
  daemon + dashboard and drives the real flow in a REAL browser (chrome-devtools MCP).
  USE THIS whenever you want to SEE or CHECK how something works in the dashboard, verify
  a change end-to-end, drive the dispatch / SSE / kill-switch flow, hunt UX bugs the unit
  tests miss, or run the deterministic E2E gate before a commit. Two modes: EXPLORE
  (adaptive browser investigation) and GATE (`npm run test:e2e-gate`, emits the
  commit/push pass-sentinel). Triggers: "see it in the dashboard", "check this in the UI",
  "does the dispatch flow work", "drive the browser", "run the e2e", "verify end-to-end".
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - "mcp__plugin_chrome-devtools-mcp_chrome-devtools__*"
---

# e2e-fleet — live two-layer E2E for cortextOS

Boots an **isolated, zero-bill** daemon + dashboard and exercises the real flow across
**both layers** — daemon (CLI/IPC, ledger) and dashboard UI (SSE live-updates, dispatch,
kill-switch) — in a **real browser**. `npm test` is all-green even when real UX is broken;
this is the check that catches what unit tests miss.

## Pick a mode

| Mode | When | What it does |
|---|---|---|
| **GATE** | Verifying a change for commit; the commit/push hook blocked you | Run the deterministic suite `npm run test:e2e-gate`. On green it emits the tree-bound pass-sentinel the gate requires. Ungameable. |
| **EXPLORE** | "Let me see / check / verify this in the dashboard"; hunting UX bugs | Boot the isolated stack, drive Chrome adaptively via chrome-devtools MCP, observe, and report bugs/UX issues/improvements. No sentinel. |

Both modes use the SAME isolation, billing-safety, and always-teardown guarantees below.

## 🔴 Billing-safety invariants (NEVER violate)

The fleet runs on Kris's MAX subscription — a stray spawn bills real money. Every run MUST:

1. **Disable every agent before boot** — write `~/.cortextos/<instance>/config/enabled-agents.json`
   with each repo agent (`orgs/*/agents/*`) set `{"enabled": false}`. The daemon auto-boots
   enabled agents (`src/daemon/agent-manager.ts`), so skipping this spawns ~5 billed sessions.
2. **`CTX_E2E_FAKE_RUNTIME=1`** — swaps ALL dispatch lanes to the zero-bill `FakeAdapter`
   (`src/runtime/adapters/fake.ts`). No real Claude/Codex session can spawn.
3. **No `ANTHROPIC_API_KEY` in env** — `unset` it (the start command fail-closes on it).
4. **Foreground daemon, NOT pm2** — `cortextos start --instance <demo> --foreground`. The pm2
   path ignores `--instance` and boots the default billed roster.
5. **Process-spawn audit** — confirm no `claude`/`codex` child processes appear. The GATE suite
   does this automatically and refuses to emit a sentinel otherwise.
6. **Real billed dispatch is OFF by default** — only with explicit user approval AND
   `CTX_E2E_REAL_CLAUDE=1` (existing gated pattern). Never spawn real sessions unprompted.

## GATE mode

```bash
npm run build            # dist/ must be current (the harness runs dist/cli.js)
npm run test:e2e-gate    # isolated zero-bill boot → assert checklist → audit → teardown → sentinel
```

The suite (`tests/playwright/e2e-gate.spec.ts`) boots instance `e2e-gate`, logs in, and asserts:
SSE/ledger dispatch under budget, over-budget refusal (no extra live run), cancel-team,
kill-switch behavior + banner, security (401 unauth / 403 cross-origin / 400 malformed), and a
zero-bill process audit. On full green it writes `.planning/verify/<ts>/e2e-pass.json` bound to
the staged tree — which unblocks the commit/push gate. Report the pass/fail summary; if it
fails, report which assertion and fix the implementation (not the test).

## EXPLORE mode (adaptive, chrome-devtools MCP)

Use for "show me / let me check this in the dashboard" and open-ended UX bug hunting.

1. **Isolate + boot (zero-bill):**
   ```bash
   unset ANTHROPIC_API_KEY
   export CTX_E2E_FAKE_RUNTIME=1 CTX_N4_DISPATCH_ENABLED=true
   # write enabled-agents.json with all agents disabled (see invariant 1), then:
   node dist/cli.js start --instance e2e-demo --foreground   # background it; wait for ~/.cortextos/e2e-demo/daemon.sock
   node dist/cli.js dashboard --instance e2e-demo --hostname 127.0.0.1 --port <free>   # webpack; wait for HTTP 200 on /login
   ```
   Kill any stale `next-server` scoped to this instance first; never bind `0.0.0.0` or use Turbopack.
2. **Log in + drive (chrome-devtools MCP):** read creds from `~/.cortextos/e2e-demo/dashboard.env`
   (`ADMIN_USERNAME`/`ADMIN_PASSWORD`). Login form: `input[name="username"]`, `input[name="password"]`,
   `button[type="submit"]`. Then `take_snapshot` / `take_screenshot` per step as you navigate.
3. **Inject zero-bill data** to make the UI show state without a billed run — atomic write
   (tmp+`mv`) of `RunRecord`/`TeamState`/`RuntimeBoundaryRecord` to `~/.cortextos/e2e-demo/state/{runs,teams,runtimes}/`
   (shapes in `src/runtime/run-authority.ts` + `dashboard/src/lib/types.ts`). Or trigger a real
   (fake-adapter) dispatch via `POST /api/dispatch`.
4. **Screenshots → `.planning/demo-screens/<ts>/`** (workspace root, NEVER `/tmp`). Redact
   cookies/auth headers/session tokens from anything you save.
5. **Report** concrete bugs / UX issues / improvements with screenshots — that is the point of
   this mode.

## 🔴 Teardown (ALWAYS, even on failure)

```bash
node dist/cli.js daemon stop --instance e2e-demo
# kill the dashboard process group; verify the port is closed; the GATE suite does this in afterAll.
```
Confirm no leftover daemon/dashboard/next-server processes and the instance dir can be wiped
(`~/.cortextos/e2e-demo`). If isolation can't be proven, say so loudly.

## Checklist template

Mirror `.planning/verify/20260625T114145/gate3-checklist.md` (Manual Demo → Security Spot-Check
→ N3 Regression) when doing a structured manual pass.
