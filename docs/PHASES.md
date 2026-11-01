# The roadmap's phases, as PHASE-n

**These are not the tickets on the owner's board.** Those are numbered EQ-101 to EQ-115, they live outside
this repository, and this file makes no claim about them. An earlier version of this file reused those
numbers for the roadmap's phases, which was wrong and caused exactly the confusion it deserved: the same
number meant two different pieces of work.

The roadmap has Phases 0-15; each one is listed here as **PHASE-n**, with what it means and its real status.

Status: **done** means the behaviour exists and was verified against the running marketplace; **partial**
means the code is there and something outside the repository is still missing.

| Phase | What it is | Status |
|---|---|---|
| PHASE-0 | working copy, project memory, checks | **done** |
| PHASE-1 | accounts, roles, sessions, lockout, audit trail | **done** |
| PHASE-2 | data built for real traffic: constraints, times, search, paging | **done** |
| PHASE-3 | events, a job queue with leases and retries, visible failures | **done** |
| PHASE-4 | the agent runtime: policy gate, tools, budgets, approvals, runs | **done** |
| PHASE-5 | first Ops agents in shadow mode, with an inbox and a kill switch | **partial** - needs two weeks of shadow data |
| PHASE-6 | customer agents: support that answers without a person | **done** |
| PHASE-7 | seller agents: notes to a listing, pricing inside the band | **done** |
| PHASE-8 | payments in test mode: UPI, webhooks, refunds, idempotency | **done** |
| PHASE-9 | shipping: one state machine, signed webhooks, failed attempts | **partial** - carrier booking is simulated |
| PHASE-10 | messages and languages: email in the customer's language, retried | **partial** - email done, WhatsApp needs a number |
| PHASE-11 | seller sign-up, KYC and listing approval | **done** |
| PHASE-12 | money and risk: reconciliation, payouts that show what and why | **done** |
| PHASE-13 | Ops Manager agent and an MCP server for the owner | **done** |
| PHASE-15 | compliance, hardening and go-live | **partial** - code done, owner items in GOLIVE.md |

## What the partial ones still need

- **PHASE-5** two weeks (or 100 cases) of shadow data is a calendar fact. The runtime, inbox and kill switch exist.
- **PHASE-9** one state machine, failed attempts and a signed webhook exist and are tested; a carrier account
  is missing, so booking remains simulated.
- **PHASE-10** email is queued, written in English, Hindi or Telugu, retried five times and then parked with
  the reason. WhatsApp needs a business number and approved templates.
- **PHASE-15** every code side item is done: security headers, robots, backups, tests. Legal identity, GST, an
  email provider, live keys and a hostname are the owner's, and `docs/GOLIVE.md` lists them.

## Where the work is

| Phase | Lives in |
|---|---|
| PHASE-0 | `CLAUDE.md`, `docs/`, `.github/workflows/test.yml` |
| PHASE-1 | `auth/`, `ops/StaffPermissions`, `audit_log` |
| PHASE-2 | `migrations/`, `catalog/CatalogRepository` |
| PHASE-3 | `jobs/JobQueue`, `jobs/JobRunner`, `events` |
| PHASE-4 | `agents/` (policy, tools, budget, approvals, loop) |
| PHASE-5 | `agents/`, `ops/AgentsController` |
| PHASE-6 | `shop/ShopAssistantController` |
| PHASE-7 | `seller/SellerDraftController`, `seller/SellerPanelsController` |
| PHASE-8 | `integrations/Razorpay*`, `payments/` |
| PHASE-9 | `shipping/` |
| PHASE-10 | `notify/`, `invoices/` |
| PHASE-11 | `seller/SellerApplicationController`, `integrations/Kyc` |
| PHASE-12 | `settlement/`, `ops/` payouts |
| PHASE-13 | `mcp/McpMain`, `ops/AgentsController` |
| PHASE-15 | `SecurityHeaders`, `scripts/backup-equidron.ps1`, `docs/GOLIVE.md` |
