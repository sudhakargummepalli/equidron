# Progress

## Current phase
Phase 2b · Types, search and paging, on branch `phase-2b-types-search` (built on `phase-2-concurrency`). Built and
tested locally; its tests also run on real PostgreSQL in CI once the branch is pushed.
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
Push `phase-2b-types-search` so CI runs the migration and search tests on real PostgreSQL. Then Phase 3: events,
background jobs and monitoring (roadmap gap 2: nothing runs on its own).

Before Phase 2b reaches production: export a backup of the Netlify database (the migration rewrites columns).

## Open questions
- Should two-step sign-in become required for admin staff now, or at go-live (Phase 15)? Recommended: Phase 15.
