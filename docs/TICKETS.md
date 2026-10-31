# Tickets EQ-101 to EQ-115

These are the roadmap's phases written as tickets, because the ticket list itself lives outside this
repository. Each one names what "done" means in a way that can be checked against the running marketplace.

Status: **done** means the behaviour exists and was verified; **partial** means the code is there and one
part still needs a person or a key; **todo** means not started.

| Ticket | Phase | What it is | Status |
|---|---|---|---|
| EQ-101 | 0 | A working copy, project memory and checks on every push | **done** |
| EQ-102 | 1 | Real accounts, roles, sessions, lockout and an audit trail | **done** |
| EQ-103 | 2 | Data built for real traffic: constraints, times, search, paging | **done** |
| EQ-104 | 3 | Events, a job queue with leases and retries, and visible failures | **done** |
| EQ-105 | 4 | The agent runtime: policy gate, tools, budgets, approvals, runs | **done** |
| EQ-106 | 5 | First Ops agents in shadow mode, with an inbox and a kill switch | **partial** |
| EQ-107 | 6 | Customer agents: support that answers without a person | **todo** |
| EQ-108 | 7 | Seller agents: photos to a listing, pricing inside the band | **partial** |
| EQ-109 | 8 | Real payments in test mode: UPI, webhooks, refunds, idempotency | **done** |
| EQ-110 | 9 | Shipping in a sandbox: labels, webhooks, failed attempts | **partial** |
| EQ-111 | 10 | Messages, invoices and languages, including WhatsApp | **partial** |
| EQ-112 | 11 | Seller sign-up, KYC and listing approval | **done** |
| EQ-113 | 12 | Money and risk: reconciliation, payouts that show what and why | **partial** |
| EQ-114 | 13 | Ops Manager agent and an MCP server for the owner | **partial** |
| EQ-115 | 15 | Compliance, hardening and go-live | **todo** |

## What the partial ones are missing

- **EQ-106** two weeks of shadow data is a calendar fact, not code. The runtime, inbox and kill switch exist.
- **EQ-108** the pricing band is enforced; the photo-to-listing agent is not built.
- **EQ-110** carrier booking and AWB webhooks are stubbed, so a shipment moves on our side only.
- **EQ-111** email and in-app messages work; WhatsApp needs a business number and template approval.
- **EQ-113** settlement batches exist and reconcile; the payout approval view is being finished.
- **EQ-114** agents run and report; the MCP server for the owner is not exposed yet.
