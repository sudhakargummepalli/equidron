# Equidron: notes for Claude Code

Equidron is a demo marketplace (Store, Seller Central and Ops) on Node.js, PostgreSQL and Netlify.
We are turning it into a marketplace that real customers can use and that AI agents run day to day,
following `docs/Equidron-Agentic-Roadmap.pdf`. The short version of every phase is in `docs/ROADMAP.md`;
where we are is in `docs/PROGRESS.md`; why we chose what we chose is in `docs/DECISIONS.md`.

## Install, run, test

- Node.js 22 or newer (`engines` in package.json; CI and Netlify use 22).
- `npm install` (CI uses `npm ci`).
- `node app.js` starts everything on http://localhost:8000 (`/shop/`, `/seller/`, `/ops/`), with an
  in-process PGlite database in `data/pg`. Options: `--port 8000`, `--db data/pg | memory | postgres://...`,
  `--reset`. `DATABASE_URL` selects a real PostgreSQL server.
- `node --test` runs every test in `tests/` on an in-memory PGlite database, with a scripted stand-in for
  Claude. No server, no API key and no network are needed.
- Demo accounts are in `src/sample-data.json` (shared demo password; see README "Demo accounts").
- Environment variables (set in Netlify, or in a local `.env` that git ignores, never in code):
  `DATABASE_URL`, `NETLIFY_DB_URL` (set by Netlify Database), `ANTHROPIC_API_KEY` (local only; Netlify's AI
  Gateway supplies it there), `EQUIDRON_ASSISTANT_MODEL`, `EQUIDRON_ASSISTANT_DAILY_LIMIT`,
  `PAYMENT_STATEMENT_CSV_URL`, `EQUIDRON_SEED_DEMO` (1 = sample accounts work),
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` (the bot's @name, for the link card).

## Map of the code

```
app.js                       local entry: parses flags, opens the database, starts src/server.js
netlify/functions/api.mjs    Netlify entry for /api/* and /img/*  -> src/fetch-handler.js
netlify/database/migrations/ SQL migrations for Netlify Database, applied in file-name order
src/server.js                Node http server (local): static files + handleApi; openDatabase()
src/fetch-handler.js         Fetch-API adapter used by the Netlify function
src/api.js                   route table (route(method, area, pattern, fn, isPublic, {readOnly, prepare}))
                             and handleApi(): area check, sign-in, one transaction per write request
src/db.js                    SCHEMA, ? -> $n conversion, all/one/run/scalar, transaction()
src/auth.js                  passwords (scrypt), sessions, sign-in, lockout, codes, TOTP, staff permissions, agent accounts
src/audit.js                 audit_log: actingAs(), audit(), who did what
src/mask.js                  mask(): hides emails, phones, PAN, card and bank numbers
src/guardrails.js            rules per role (customer, seller, staff): refuse or flag, all recorded
src/outbox.js                emails waiting to be sent (Ops admins read them until Phase 10)
src/security-headers.js      CSP and other headers for the local server (same as netlify.toml)
src/events.js                emit(): the events outbox, written inside service functions
src/jobs.js                  the job queue: dispatch, claim (SKIP LOCKED + lease), retries, tick, settings
src/job-kinds.js             what each job kind does (order email, simulator, backup, the three Ops agents)
src/backup.js                export every table as JSON, restore into an empty database
src/worker.js                the background worker's secret check and copy limit
src/log.js                   JSON log lines with request ids; reportError() to error_log and Sentry
src/netlify-db.js            which database the Netlify functions use
src/telegram.js              the Telegram bot: linking, commands, order and product answers
netlify/functions/tick.mjs   scheduled every minute (production only); wakes the worker
netlify/functions/worker-background.mjs  background function that runs jobs
src/catalog.js               search, ranking, offers, delivery promise, stock by warehouse
src/listings.js              seller listings, validation, submissions, automatic approval and Ops review
src/orders.js                cart, checkout, payments, shipments, returns, tickets, settlement
src/payments.js              SimulatedProvider (cards, UPI, COD, bank transfer)
src/statement.js             bank-statement check for bank-transfer payments (Google Sheet CSV or sample)
src/assistant.js             store assistant: answer() on the agent runtime, daily question limit
src/seller-assistant.js      Seller Central assistant on the older converse() loop
src/agents/runtime.js        runAgent(): one loop for every agent, with limits, retries and masked traces
src/agents/tools.js          the tool registry: risk, allowed agents, one transaction + idempotency key
src/agents/policy.js         decide(): execute / shadow / needs_approval / deny, hard gates, budget, pause
src/agents/approvals.js      the approval inbox: an approved action runs from its stored payload, once
src/agents/agents.js         agent rows, their own accounts, levels, budgets, pause all
src/agents/models.js         model routing and the price table that turns usage into cost
src/agents/profiles.js       each agent's prompt, its context and its defaults
src/agents/evals.js, evals/  the eval sets that ship with the agents, and how they are loaded
scripts/eval.js              an agent's eval set against the real model (dry run free; --yes costs credits)
src/notify.js                in-app notifications
src/seed.js, sample-data.json  sample sellers, products, offers, users and orders
static/shop|seller|ops       AngularJS 1.8 pages; static/common holds shared JS, CSS and the chat panel
tests/                       node:test suites (order flow, PostgreSQL, assistants, bank statement, agents)
```

## Conventions

- SQL uses `?` placeholders; `db.js` numbers them (`$1`, `$2`, ...) before sending. Never build SQL by
  joining user input into a string.
- Times: write `now()` (an ISO moment in UTC) into TIMESTAMPTZ columns; use `indiaDate()` and `addDays()` for
  calendar days. JSONB columns come back as objects (`loads()` accepts both); flags are booleans (`WHERE is_sample`,
  `SET is_read = true`), never 0/1.
- Money is stored and passed as integer paise (`price_paise`, `amount_paise`); format with `orders.inr()`
  only for display.
- No global lock: transactions run side by side. When code reads a row and then writes based on it, lock that
  row (`SELECT ... FOR UPDATE`, order row before shipment or return rows) or use a guarded UPDATE and check
  `changes()`. Jobs that must run alone use `lockNamed(db, name)`. Concurrency tests go in
  `tests/concurrency.test.js`, which CI also runs on real PostgreSQL (`TEST_DATABASE_URL`).
- Every write runs inside one transaction. `handleApi` opens it for every non-GET route; service functions
  expect to be called inside it and never open their own. Read-only POST routes use `{ readOnly: true }`;
  slow outside calls (such as fetching the bank statement) go in a `prepare` hook, which runs before the
  transaction.
- Errors meant for users are `AppError` (`src/errors.js`) with an HTTP status and a plain sentence.
- Schema changes: add a NEW migration file in `netlify/database/migrations/` (timestamped name), never edit
  one that has been applied, and keep `SCHEMA` in `src/db.js` in step (a test compares them).
- Tests run on PGlite (`openDatabase('memory')`) and use the scripted AI stand-in (`scripted(...)` in the
  assistant tests). Lower `settings.pbkdf2Rounds` in tests to keep them fast.
- Audit: a service function that changes something important calls `audit(db, action, entity, id, before, after)`
  (`src/audit.js`); the actor comes from the request, so it isn't passed in. Write routes that record nothing get one
  row automatically. Ops decisions also store `decided_by`.
- Permissions: every Ops route needs a staff permission listed in `OPS_PERMISSIONS` in `src/api.js`; an unlisted
  route needs admin. Agent accounts (role `agent`) never get a session.
- Personal data in logs: pass log text through `mask()` (`src/mask.js`). Sign-in failures are answered with a
  `Reply`, not thrown, so attempt records survive the transaction.
- Guardrails: user text that reaches a model or a reviewer goes through `src/guardrails.js`. Refuse what must
  not happen at all (card numbers, attempts to rewrite instructions, abuse); flag what a person should see
  (contact details, odd listing text). Every refusal and flag is written to `guardrail_events`, masked, and Ops
  → Guardrails shows them. A flagged listing always gains a review reason, so it can never auto-approve.
- Demo mode: the sample accounts and shared password work only with `EQUIDRON_SEED_DEMO=1` (`node app.js` and the
  tests set it). Security headers live in `src/security-headers.js` and `netlify.toml`, kept equal by a test.
- Events and jobs: when something other parts may react to happens, call `emit()` inside the same transaction, with
  ids and amounts only. New work is a job kind in `src/job-kinds.js` plus a line in `LISTENERS` (or an `enqueue()`
  with a dedupe key). A handler runs in one transaction with marking its job done, and must be safe to run again if it
  fails part-way. Log with `log()`/`reportError()` from `src/log.js`, not console.
- Agents: a tool is the only way an agent changes anything. A new tool names its risk (read, write, money,
  irreversible) and the agents allowed to use it, requires a `reason` unless it is a read, and calls a service
  function (never raw SQL) so `executeTool()` can run it in one transaction under an idempotency key. The policy
  check in `src/agents/policy.js` decides execute, shadow, needs approval or deny, in code and never only in the
  prompt. `runAgent()` writes `agent_runs`/`agent_steps` with `mask()`ed text, and keeps its own short writes, so
  call it outside a request transaction (a `readOnly` route). An agent job kind is registered in
  `src/job-kinds.js` under `AGENT_KINDS` and runs outside the job's transaction; a retried job must not start a
  second run, so guard on the exercise's subject before calling `runAgent()`.
- Comments explain why, not what. Keep the existing plain style: ES modules, no build step, no framework on
  the server.

## Working rules

- One phase at a time, in the PDF's order unless the owner chooses otherwise. Never skip the "done when"
  checks. For each phase: explain it, show a plan (files, migrations, tests, risks, what the owner must do),
  wait for "go", work on a branch `phase-<number>-<short-name>`, tests first, commit after each green step,
  check the "done when" list, update `docs/PROGRESS.md` and `docs/ROADMAP.md`, then stop.
- Teach as you go: simple words, explain each new term the first time, show where it lives in the code.
  If the owner writes in Telugu, answer in Telugu.
- All tests must pass before every commit. Tests use the scripted AI stand-in. Call the real model only
  when the owner agrees, after giving the rough cost.
- Secrets: never ask for API keys, passwords or tokens in chat, and never write them into files. They go in
  Netlify environment variables or a local `.env` that git ignores. Test-mode and sandbox keys only.
- No real personal data. Use the sample data. Mask phone numbers, emails, PAN, bank and card numbers in logs
  and in anything sent to the AI.
- Agents follow the PDF's safety model: they act only through tools that call the existing service
  functions; every tool has a risk level; a policy check in code (never only the prompt) decides execute,
  shadow, needs approval or deny; money going out, deletions, permission changes and bulk messages always
  need a person's approval record; every agent has a budget and a kill switch.
- Don't push to main, merge, deploy to production or change Netlify or GitHub settings unless the owner says
  so in that message. Branches, pull requests and deploy previews are fine when asked for.
- Netlify limits: normal functions 60 s, scheduled functions 30 s (production deploy only), background
  functions 15 min with automatic retries. The AI Gateway has no batch API, no beta features, a 200k-token
  context and a per-minute limit that depends on the plan.
- If something is unclear, or the PDF and the code disagree, stop and ask, with 2-3 options and a
  recommendation. The code is the truth; record the difference in `docs/DECISIONS.md`.
