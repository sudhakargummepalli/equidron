# Progress

## Current phase
Phase 4 · The agent runtime, on branch `phase-4-agent-runtime` (cut from `phase-3-jobs`, whose content equals `main`).
Built, tested and pushed; CI runs on the branch.
Phases 0–3 are merged into `main` (pull requests #1–#5). Phase 3's job tests are green on real PostgreSQL in CI.

## Done
- Phase 0: CLAUDE.md, docs/ROADMAP.md, docs/PROGRESS.md, docs/DECISIONS.md, the PDF in docs/, and
  `.github/workflows/test.yml`. The Actions run for 8c8edbd passed (run 39212946058).
- Phase 1:
  - Audit trail (`audit_log`, `src/audit.js`) for every write request; `decided_by` on submissions and returns, shown in Ops.
  - `mask()` (`src/mask.js`) on every log line and in the Ops audit view.
  - Staff permissions (support, catalog, logistics, finance, admin), Ops → Staff page, agent accounts that can't sign in.
  - scrypt passwords with re-hash of old PBKDF2 ones; hashed session tokens; new token at sign-in; sign out of all devices.
  - Sign-up confirmed by an emailed code; password reset by code; lockout after 5 failures in 15 minutes;
    optional two-step sign-in with an authenticator app for sellers and staff (Security page).
  - Outbox (Ops → Outbox) holds the emails until Phase 10.
  - Demo switch `EQUIDRON_SEED_DEMO=1`; security headers in netlify.toml and the local server; SRI on AngularJS.
- `node --test`: 79 of 79 pass (59 from before, 20 new).
- Phase 2a: the global write lock is gone; guarded stock reservation; row locks on decisions, cancels, shipments and
  refunds; named locks for settlement and the seed; idempotent checkout (`idempotency_keys`); PostgreSQL 16 in CI.
  `node --test`: 84 of 84 pass.
- Phase 2b: TIMESTAMPTZ / DATE / JSONB / BOOLEAN columns (one re-runnable migration), India dates for calendar days,
  full-text search with synonyms and pg_trgm typo matching, paged search with Previous/Next. `node --test`: 93 of 93 pass.
- Phase 3: events outbox, job queue (SKIP LOCKED, leases, backoff, dead jobs), tick and background worker functions, a
  local ticker, order confirmation emails, the shipment simulator as a job, weekly JSON backups with a tested restore,
  request ids, JSON logs, error_log (+ optional Sentry), /api/health and the Ops System page. `node --test`: 104 of 104 pass.
- Phase 4:
  - Tables `agents`, `agent_runs`, `agent_steps`, `approvals`, `eval_cases`, `eval_results`
    (migration `20261022000000_agents.sql`), and an account per agent (role `agent`, which no page accepts).
  - `src/agents/tools.js`: the registry. Every call runs the ordinary service function in one transaction under an
    idempotency key; input is checked against the tool's schema first.
  - `src/agents/policy.js`: `decide()` = execute / shadow / needs_approval / deny, from the tool's risk, the agent's
    level, the amount limit, today's spend and the pause switch. Hard gates are always a person.
  - `src/agents/runtime.js`: `runAgent()` with a model, step, token and daily-spend limit per agent, retries on 429 and
    5xx, refusals, structured output, cost from the reported usage, and a masked row for every model and tool call.
  - `src/agents/approvals.js`: the inbox. Approving runs the stored payload exactly once (two people clicking: one wins).
  - Ops → Approvals, Agents (on/off, level, model, budget, spend, pause all) and Agent runs (a step view), admin-only.
  - The store assistant now runs on `runAgent()` with four read tools, so a chat leaves a run, its steps and its cost.
  - `scripts/eval.js <agent>`: a dry run prints the cases and the likely cost; `--yes` calls the real model.
  - `node --test`: 144 of 144 pass (104 from before, 40 new).

## How to check
- `npm ci` then `node --test`: all tests pass.
- `node app.js --reset`, then follow DEMO.md Part 5 (sign-up code, reset, lockout, staff permissions, who decided,
  two-step sign-in, sign out everywhere).
- `EQUIDRON_SEED_DEMO=0 node app.js --db memory`: the sample accounts can't sign in.
- Phase 4, without any model credentials: sign in to Ops as `ops@example.com`, open **Agents** (both agents are listed;
  `ops_helper` is off, `store_assistant` is on), switch a level, try **Pause all**, and open **Approvals** (empty) and
  **Agent runs** (empty until something runs). This proves the pages, switches and permissions.
- Phase 4, with a model (`ANTHROPIC_API_KEY` in a local `.env`, never in git): Ops → Agents → `ops_helper` → on, L3,
  then "Run once" with "Move shipment …". Then set L1 and run again (nothing changes, the step says shadow), and L2
  (the run waits and the action appears in Approvals; approving runs it once). Agent runs shows each step, tokens and cost.
- `node scripts/eval.js ops_helper`: free dry run. Nothing calls the model without `--yes`.

## Still open (needs the owner)
- Phase 4: review the branch and, when ready, open the pull request into `main`. A hands-on demo needs model credentials.
- Decide each agent's daily budget before Phase 4 reaches production (the defaults are $1/day for `ops_helper`,
  $2/day for `store_assistant`).
- Owner settings from earlier phases still stand: `EQUIDRON_SEED_DEMO=1` and `WORKER_SECRET` in Netlify, a database
  backup before the Phase 2b migration reaches production, optionally `SENTRY_DSN` and an uptime check on `/api/health`.

## Next
Phase 5: the first Ops agents (Listing Review in shadow mode, Fulfilment Watch, the Daily Brief), on this runtime.

## Open questions
- Should two-step sign-in become required for admin staff now, or at go-live (Phase 15)? Recommended: Phase 15.
