# Equidron: notes for Claude Code

Equidron is a marketplace with three faces: the **Store** (customers), **Seller Central** (shops) and
**Ops** (the people who run it, plus the agents). It runs on **Java 17 + Spring Boot 3** with **PostgreSQL
16**. It is deployed **locally only** — never to Netlify.

`docs/ROADMAP.md` is the short version of the phases, `docs/PROGRESS.md` says where we are,
`docs/TICKETS.md` maps EQ-101…EQ-115 to their real status, `docs/DECISIONS.md` says why, `docs/CUTOVER.md`
explains the move off Node, and `docs/GOLIVE.md` lists what only the owner can supply.

## Install, run, test

- Java 17, Maven, PostgreSQL 16 on port 5432. Databases: `equidron_live` (the marketplace),
  `equidron_test` (tests only), role `equidron` / `equidron-local`.
- `cd java-backend && mvn verify` — unit and database tests. They must be pointed at the test database:
  `DATABASE_URL=jdbc:postgresql://127.0.0.1:5432/equidron_test`.
- `powershell -File scripts/start-java.ps1` starts the marketplace on http://localhost:8080 from `.env`;
  `-Bot` also starts Telegram polling; `-Database` picks another database.
- The pages are `static/`, served straight from disk with `Cache-Control: no-store`, so an edit is visible on
  a normal reload.
- The schema is `migrations/`. It is copied **into the jar** at build time (`maven-resources-plugin`) and
  Flyway reads `classpath:db/migration`, because a filesystem location depends on the working directory the
  JVM happens to be started in.
- Sample data: `scripts/seed-catalogue.sql` (products, offers, stock) and `scripts/restock-inventory.sql`.
  Both are plain SQL and safe to run twice.
- Backups: `scripts/backup-equidron.ps1` (keeps the last 14; refuses a dump under 10 KB).

## Map of the code

```
java-backend/src/main/java/in/equidron/
  ApiApplication             the Spring Boot entry, and where scheduling is switched on
  SecurityHeaders(Filter)    CSP and friends, sent on every response, asserted by a test
  WebPages                   welcome pages and trailing-slash routes for /shop/ /seller/ /ops/
  auth/                      passwords (scrypt), sessions, sign-in, lockout, sign-up, reset, staff login
  catalog/                   search, categories, product detail, generated images (/img/p<id>-<n>.svg)
  cart/                      cart, addresses
  checkout/                  one-transaction checkout, orders, returns, order detail
  seller/                    dashboard, listings, submissions, drafts, ledger, shipments
  ops/                       the panels, the actions, the approval inbox, staff permissions
  shipping/                  ShipmentStates (the one state machine) and the signed carrier webhook
  payments/ integrations/    Razorpay, simulated carrier, KYC
  jobs/                      JobQueue (SKIP LOCKED + lease), JobRunner, the scheduled tick
  notify/                    OutboxService (emails in the customer's language) and OutboxMailer
  agents/                    policy gate, tool registry, budgets, approvals, loop, model client
  mcp/McpMain                the read-only MCP server the owner talks to from Claude
  invoices/ rights/ uploads/ support/ bot/ settlement/
static/                      shop, seller, ops (AngularJS 1.8) and static/common
migrations/                  the schema, in file-name order
scripts/                     start, backup, seed (.sql), walkthrough.ps1
docs/                        CUTOVER, DECISIONS, GOLIVE, MCP, PROGRESS, ROADMAP, TICKETS
```

## Conventions

- **Money is integer paise** everywhere (`price_paise`, `amount_paise`); format only for display.
- **One transaction per write.** Services take a `JdbcTemplate` and assume they are already inside one.
- **Lock before you decide.** `SELECT … FOR UPDATE` on the rows you will change (offer stock, order row), or a
  guarded `UPDATE … WHERE status = 'pending'` and check the count.
- **Idempotency is a row, not a hope**: `idempotency_keys` for requests, `dedupe_key` for jobs, and the
  carrier's `event_id` on the shipment timeline. A retry must be a no-op, not a second delivery.
- **A page is a contract.** Read the template before writing an endpoint: the cart reads `l.image`, the
  checkout reads `totals`, the agents panel reads `x.agents`, the approvals tab reads `{approvals: […]}`.
  A shape mismatch looks exactly like a broken feature and costs a round trip with the owner every time.
- **New schema change = a new file in `migrations/`**, never an edit to an applied one. The jar carries them.
- **Mask before logging**: `Mask.mask()` for emails, phone numbers, PAN and card numbers.
- **Agents act only through tools.** Every tool names its risk; the policy gate decides execute / shadow /
  needs approval / deny in code, never only in the prompt; money out, deletions and permission changes need a
  person's approval; every agent has a budget and the kill switch respects `settings.agents_paused`.
- Comments explain *why*. A comment that repeats the code is noise.

## Working rules

- **Never deploy to Netlify. Deploy locally only.** Every change is verified on http://localhost:8080 and
  pushing to GitHub is the only remote step.
- **Every update adds a dated line to `docs/DECISIONS.md` in the same commit**, with the reason. A change
  without an entry is not finished.
- All tests must pass before a commit. A real model call costs money: say the rough cost and wait for a yes.
- Secrets live in `.env` (git-ignored) and are never printed in chat, never written into tracked files.
- No real personal data: use the sample catalogue. Mask what reaches logs or a model.
- Teach as you go — plain words, explain each new term, show where it lives. If the owner writes Telugu,
  answer in Telugu.
- When the roadmap and the code disagree, the code is the truth: say so and record it in `docs/DECISIONS.md`.
