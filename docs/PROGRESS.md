# Progress

## Current phase
Phase 3 · Events, background jobs and monitoring, on branch `phase-3-jobs` (built on `phase-2b-types-search`). Built and
tested locally; its job tests also run on real PostgreSQL in CI once the branch is pushed.
Phase 2b (`phase-2b-types-search`) is pushed, CI green including real PostgreSQL (run 39223008751).
Phase 2a (`phase-2-concurrency`) is pushed, CI green including real PostgreSQL (run 39219849297).
Phase 1 (`phase-1-accounts`) is pushed, CI green, waiting for the owner's review and merge.

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

## How to check
- `npm ci` then `node --test`: all tests pass.
- `node app.js --reset`, then follow DEMO.md Part 5 (sign-up code, reset, lockout, staff permissions, who decided,
  two-step sign-in, sign out everywhere).
- `EQUIDRON_SEED_DEMO=0 node app.js --db memory`: the sample accounts can't sign in.

## Still open (needs the owner)
- Phase 0: open the pull request for `phase-0-setup`, check the Netlify deploy preview, protect `main`.
- Phase 1, before merging: set `EQUIDRON_SEED_DEMO=1` in Netlify environment variables for the demo site, or its
  sample sign-ins stop working after the deploy. Then push `phase-1-accounts` and open its pull request.

## Next
Push `phase-3-jobs` so CI runs the job tests on real PostgreSQL. Then Phase 4: the agent runtime (tools, policy check,
approvals, budgets, traces, kill switch).

Owner, for Phase 3 to run on Netlify: add WORKER_SECRET (long random text) in Netlify environment variables; optionally
SENTRY_DSN and an uptime check on /api/health; then a production deploy when you choose.

Before Phase 2b reaches production: export a backup of the Netlify database (the migration rewrites columns).

## Open questions
- Should two-step sign-in become required for admin staff now, or at go-live (Phase 15)? Recommended: Phase 15.
