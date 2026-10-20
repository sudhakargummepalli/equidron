# Roadmap checklist

Short version of `docs/Equidron-Agentic-Roadmap.pdf` (18 Oct 2026, written against commit 7639c8c).
Open the PDF only for details. Tick a box when it is true on `main`.
Stages: A = foundations, B = agent platform and first agents, C = real money, shipping and sellers, D = run and launch.
Autonomy levels: L0 off, L1 shadow (decide, don't act), L2 needs approval, L3 acts within limits, L4 fully autonomous.

## Phase 0 · Set up, understand, automate checks (A · S)
Goal: a working copy everyone understands; every push tested and deployed automatically.
- [x] Clone, `npm install`, `node app.js`, walk through DEMO.md, `node --test`
- [x] CLAUDE.md, docs/ROADMAP.md, docs/PROGRESS.md, docs/DECISIONS.md, PDF in docs/
- [x] `.github/workflows/test.yml`: Node 22, `npm ci`, `node --test` on push and pull request
- [ ] Netlify: deploys from main and a deploy preview per pull request (owner checks the settings)
- [ ] Keep Netlify team login on until Phase 15
- [ ] Protect main: changes only through pull requests with green tests (owner changes GitHub settings)

Done when:
- [x] The app runs locally and all tests pass locally
- [x] All tests pass in GitHub Actions (run 39212946058)
- [ ] A pull request shows a Netlify deploy preview
- [x] The four documentation files are committed

## Phase 1 · Real accounts, roles and an audit trail (A · M)
Goal: accounts safe for real people, staff roles with only the rights they need, agent accounts, a record of every change.
- [x] Sign-up with email verification by one-time code; password reset; login rate limit and lockout (`login_attempts`)
- [x] Two-step sign-in (authenticator app) for sellers and staff
- [x] scrypt, or PBKDF2 at 600,000 rounds; re-hash old passwords at next sign-in
- [x] Sessions: store SHA-256 of the token; `Secure` cookies; new token at sign-in; "sign out of all devices"
- [x] Staff permissions (support, catalog, logistics, finance, admin); an agent role that can't sign in through any page
- [x] `audit_log` table (Appendix A) and `audit()` helper in service functions; `decided_by` on submissions and returns
- [x] Demo accounts and shared password only when `EQUIDRON_SEED_DEMO=1`
- [x] Security headers in netlify.toml (CSP, HSTS, X-Content-Type-Options, frame-ancestors); SRI on the AngularJS tag
- [x] `mask()` for phones, emails, PAN, bank and card numbers, used by logs (and later by agents)

Tests: lockout after repeated failures; reset links work once and expire; staff without finance can't run settlement;
every interface refuses an agent session; every write route creates an audit row; mask() covers each pattern.
Done when:
- [x] All new and original tests pass (79 on branch phase-1-accounts: the 59 from before plus 20 new)
- [x] No shared password outside demo mode (production leaves EQUIDRON_SEED_DEMO unset)
- [x] Ops shows who decided each listing and return
Notes: two-step sign-in is opt-in for now (see DECISIONS); codes go to the Ops Outbox until Phase 10.

## Phase 2 · Data built for real traffic (A · M)
Goal: many writers at once, correct times, searchable data.
- [x] Remove `pg_advisory_xact_lock(7426001)` from `db.transaction()`; lock only reserved inventory rows (FOR UPDATE in offer_id, warehouse_id order) or a guarded UPDATE; small named lock for settlement only
- [x] Migrations: TEXT dates to TIMESTAMPTZ (UTC stored, Asia/Kolkata shown); JSON text to JSONB; 0/1 to BOOLEAN
- [x] `idempotency_keys` table for checkout (later webhooks)
- [x] Full-text search (tsvector + GIN), trigram typos if pg_trgm exists, paging (page, size, total)
- [ ] Optional: Row-Level Security on seller tables with `SET LOCAL app.seller_id`
- [x] PostgreSQL service in GitHub Actions

Tests: 20 checkouts for the last 5 units give exactly 5 orders, stock never negative; same key twice = one order;
times keep their zone; paging returns all 102 laptops.
Done when: the concurrency test passes on real PostgreSQL in CI; migrations apply to fresh and existing data; all green.
Split: 2a (concurrency, branch phase-2-concurrency) and 2b (types, search, paging, branch phase-2b-types-search) are built.
Row-Level Security is left for later (see DECISIONS). Done-when status: concurrency test green on real PostgreSQL in CI;
the 2b migration is tested on fresh and existing data, and on real PostgreSQL in CI once the branch is pushed.

## Phase 3 · Events, background jobs and monitoring (A · M)
Goal: things happen without clicks; jobs retry; failures are visible.
- [x] `events` outbox written in the same transaction (order.placed, order.cancelled, payment.captured, shipment.status_changed, return.requested, return.received, submission.created, ticket.created, ticket.message, seller.signed_up)
- [x] `jobs` table: attempts, run_after backoff, locked_until lease, dead status, dedupe_key; claim with FOR UPDATE SKIP LOCKED
- [x] `netlify/functions/tick.mjs` (every minute) and `worker.mjs` (background, ~13 min, secret header, max N copies)
- [x] Logistics simulator as a scheduled job
- [x] JSON logs with request id; `/api/health`; error tracker; uptime check; weekly DB export + one test restore; `settings` table for switches

Tests: one job per listening agent per event; retries with growing delays end as dead; two workers never claim the same job; expired leases are picked up.
Done when: an order gives one order.placed event and a job that runs once; shipments move on their own in production; a deliberate error shows in the tracker.
Status (branch phase-3-jobs): the first is tested; the other two need the owner (production deploy with WORKER_SECRET; a Sentry DSN) and are
shown locally (node app.js moves shipments; Ops → System → Send a test error). Uptime check: the owner points one at /api/health.
seller.signed_up waits for seller sign-up (Phase 11).

## Phase 4 · The agent runtime (B · L)
Goal: one safe, visible way to run any agent.
- [x] Tables: agents, agent_runs, agent_steps, approvals, eval_cases, eval_results (Appendix A); a user account per agent
- [x] `src/agents/runtime.js`: runAgent() grown from converse(): model per agent, step/token/daily-spend limits, retries on 429/5xx, refusals, structured output, cost from usage, masked step records
- [x] `src/agents/tools.js`: registry with schema, risk (read/write/money/irreversible), allowed agents, limits, run() via service functions in a transaction with an idempotency key
- [x] `src/agents/policy.js`: decide() = execute | shadow | needs_approval | deny; hard gates; global pause
- [x] Ops pages: Approvals, Agents (on/off, level, model, budget, spend, pause all), Agent runs (step view)
- [x] Model routing; move the store assistant onto runAgent()
- [x] `scripts/eval.js <agent>` (real model, costs credits, ask first)

Tests: policy table; budget stop; pause all stops new and running runs; approved action runs once; denied tool never reaches the service.
Done when: a demo agent runs a read and a write tool; the write is recorded at L1, needs approval at L2, runs at L3; runs, steps and costs visible; all green.
Status: merged into `main` by pull request #6 (merge commit `48ee1d4`), CI green on `main` (run 39291800349).
All four "done when" points are proved by `tests/agents-runtime.test.js` (a read and a write in one run; the same write
recorded at L1, waiting at L2, running at L3; the run's steps, tokens and cost in the tables the Ops pages read).
A hands-on demo needs model credentials (`ANTHROPIC_API_KEY` in a local `.env`, or the Netlify AI Gateway): the runtime
refuses to start without them, so the pages can be checked without, but no run can happen. No eval cases exist yet; the
runner is built and its dry run is free.

## Phase 5 · First Ops agents (B · M)
- [ ] Listing Review (Sonnet) on submission.created: {decision, reasons, confidence, policy_refs}; L1 agreement score; L3 only clean high-confidence cases
- [ ] Fulfilment Watch (Haiku), hourly: late shipments, nudges, Ops task when twice as late
- [ ] Daily Brief (Sonnet, read-only), 08:00 IST (cron `30 2 * * *`)

Tests: 30 listing cases incl. injection; late-shipment query; brief numbers match SQL.
Done when: two weeks or 100 cases of shadow data with agreement score; every injection flagged; brief arrives daily in production.

## Phase 6 · Customer agents (B · L)
- [ ] Shopping Concierge (voice, Telugu): add_to_cart, update_cart, propose_cancel, propose_return (customer confirms); vague requests to filters
- [ ] Support on ticket.created / new messages: triage, facts, reply in customer's language, refunds within limit, escalate with summary; timers and rating
- [ ] Returns on return.requested / item received: eligibility, pickup, photo check, refund under limit
- [ ] Versioned `policies` table loaded into the cached prompt

Tests: 50 support cases with must-not rules; no refund over limit without approval; propose tools never change data.
Done when: eval targets met (≥90% correct, no critical errors); share solved without a person measured; Support at L2, Returns at L3 under ₹2,000.

## Phase 7 · Seller agents (B · M)
- [ ] Catalog Builder: photos + spec sheet to a draft (and Telugu), validated, seller submits
- [ ] Pricing and Stock Copilot inside the seller's min/max band (L2 suggest, L3 submit); low-stock alerts; weekly summary
- [ ] Seller Help can draft a listing change for the seller to confirm

Tests: price never leaves the band; drafts pass validate() or show errors; no cross-seller access.
Done when: photos to submitted listing in under 5 minutes; pricing respects the band in every test.

## Phase 8 · Real payments, in test mode (C · L)
- [ ] RazorpayProvider (or Cashfree) with authorize, capture, void, refund; `PAYMENT_PROVIDER`; simulator kept for tests
- [ ] Gateway checkout (UPI, cards, net banking); server-side signature check
- [ ] `/api/webhooks/payments`: signature, dedupe by event id, update payments, write events
- [ ] Seller payouts through split payments (Razorpay Route), held until the return window ends
- [ ] Nightly reconciliation; owner adds test keys in Netlify; check RBI rules with a professional

Tests: mocked gateway success, failure, duplicate webhook, refund, partial capture; bad signature rejected.
Done when: test-mode UPI marks an order paid via webhook; refund via API; duplicate webhook changes nothing; payout held until the window closes.

## Phase 9 · Real shipping, in a sandbox (C · M)
- [ ] ShippingProvider: serviceability, rates, createShipment (AWB), label, schedulePickup, track; SimulatedCarrier + one sandbox
- [ ] Pincode delivery checks and provider delivery estimates
- [ ] `/api/webhooks/shipping` to shipment_events and events
- [ ] NDR and RTO handled by Fulfilment Watch

Done when: an order books a sandbox shipment with AWB and label; a webhook moves it to delivered; a failed attempt wakes the agent.

## Phase 10 · Messages, invoices and languages (C · L)
- [ ] `messages` outbox (channel, template, language, status, provider ref) sent by the worker
- [ ] Email, WhatsApp (templates), SMS (DLT); consent and preferences, unsubscribe (DPDP)
- [ ] Inbound email/WhatsApp to Support
- [ ] GST invoice PDFs in Netlify Blobs; optional Save to Google Drive
- [ ] All text in en.json / te.json; a test fails on untranslated strings

Done when: an order sends email and WhatsApp (test numbers) in the customer's language; a WhatsApp reply reaches Support; invoices download; Telugu switches the whole store and Seller Central.

## Phase 11 · Seller sign-up, KYC and images (C · M)
- [ ] Stepwise seller sign-up (business, PAN, GSTIN, bank, pickup address, agreement)
- [ ] KYC in a provider sandbox; documents private in Blobs; no Aadhaar numbers
- [ ] Seller Onboarding agent (L2, later L3)
- [ ] Image uploads with an image check; seller details on listings

Done when: a test seller signs up, passes sandbox KYC and lists a product with one Ops approval; no pasted image links needed.

## Phase 12 · Money and risk agents (C · M)
- [ ] Fraud and Risk: rule score, one-sentence explanation; can hold, ask for prepaid, flag; never cancels or bans
- [ ] Settlement and Reconciliation nightly: payout batch for approval; monthly TCS (s.52, 0.5%) and TDS (194-O) drafts

Tests: no payout without approval; planted mismatch caught; fraud holds undoable and logged.
Done when: a month of test orders reconciles; each payout approval shows what, who, how much and why.

## Phase 13 · Ops Manager agent and an MCP server (D · M)
- [ ] Ops Manager (Opus, low effort, every 15 min): retries, re-routes, pauses misbehaving agents, escalates; can never unpause or raise limits
- [ ] MCP server (Netlify function, token): read tools and the approval inbox

Done when: a simulated courier outage is escalated within 15 minutes; the owner lists and decides approvals through MCP.

## Phase 14 · Engineering agents (D · S)
- [ ] Claude Code GitHub Action (@claude, automatic PR review; key in GitHub secrets)
- [ ] Nightly eval workflow within budget; issue when a score drops
- [ ] Error groups open issues; agent proposes a fix PR
- [ ] Branch protection: green tests and a person approves every merge

Done when: an issue labelled "agent" becomes a PR with tests that a person reviews and merges.

## Phase 15 · Compliance, hardening and go-live (D · L)
- [ ] Legal pages; grievance officer (48 h acknowledge, 1 month resolve); seller details and country of origin
- [ ] DPDP Act 2023 / Rules 2025 duties; GST e-commerce operator registration (GSTR-8)
- [ ] Security review, dependency audit, outside test of sign-in and payments, rate limits (especially AI chat)
- [ ] Load test (k6, 50 shoppers); disaster drill and runbook
- [ ] Go public: team login off, custom domain, separate demo and production; soft launch (3-5 sellers, laptops, 1-2 cities, agents L1-L2); plan the move off AngularJS

Done when: the owner has signed off every item; the first real order is delivered and settled.
