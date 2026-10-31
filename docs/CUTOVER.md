# Cutover: Java becomes the system of record

Decision (2026-10-30): the marketplace moves onto the Java backend. Node stops serving customers.

This is a runbook, not a wish list. Each step has a check you can fail safely on, and the last step
has a rollback that is one line.

## What "system of record" means here

One database, one writer, one set of secrets. Today there are two databases:

| Side | Database | Contents |
|---|---|---|
| Node | `data/pg` (PGlite, inside the Node process) | the real marketplace: products, sellers, orders, customers |
| Java | PostgreSQL 16 on 5432, database `equidron` | the same schema, seeded demo rows only |

The schema is identical because both read `netlify/database/migrations`. That is what makes a cutover
possible at all. What differs is the **data**.

## The order that cannot be rearranged

1. **Freeze writes**, then copy data, then verify counts, then unfreeze. Copying a database that is
   still being written to gives you a set of rows that never existed together.
2. **Migrate before pointing traffic at Java.** A backend that is the system of record and has no data
   looks exactly like an outage.
3. **Verify by row count and by a known order.** A count that matches is necessary, not sufficient: one
   real order must be readable through the Java API before anyone is told it works.

## Step 1 — export the marketplace from PGlite

    node --use-system-ca app.js --db data/pg --port 8010 --export-only

Output: `data/backups/export-<timestamp>.json`, one array per table, in foreign-key order.

Check: the export lists every table the migrations create (currently 54).

## Step 2 — import into PostgreSQL, in foreign-key order

    node scripts/import-into-postgres.mjs data/backups/export-<timestamp>.json

The importer inserts inside one transaction, and it resets every identity sequence afterwards
(`setval(pg_get_serial_sequence(...))`), because an explicit `id` does not advance the sequence and the
next insert would collide.

Check: row counts per table, compared against the export.

## Step 3 — verify through the API, not through psql

    GET /api/shop/search?q=<a real product>
    POST /api/shop/login           (a real customer, real password)
    GET /api/shop/orders           (returns their actual history)
    GET /api/shop/orders/<id>/invoice   (the PDF opens)

A count that matches and an API that answers are different claims. Only the second one matters to a
customer.

## Cutover completed, 2026-10-30

Run with the Node app stopped, one process:

    import ....... 53 tables, 1019 rows, counts match, 0 failed (settings excluded by decision)
    java ......... http://localhost:8080/shop/  served from PostgreSQL equidron_live
    login ........ asha@example.com                200
    orders ....... 2 real orders                   200
    order detail . id 1, 89900 paise               200
    invoice ...... application/pdf, 1107 bytes     200

The Node app is left running on data/pg-restored as the rollback, one line away:
point the browser at http://localhost:8010 again.

## Test data must not share the marketplace database

On 2026-10-31 the click-through found that `mvn verify` had been pointed at `equidron_live`, so the
integration tests wrote their fixtures into the marketplace: twenty test accounts, eighteen test orders,
a test seller with its own offers, and a walkthrough order with its invoice.

Fixed as follows, and worth keeping:

- **`equidron_test`** exists for tests. Run them with `DATABASE_URL=jdbc:postgresql://127.0.0.1:5432/equidron_test`.
  The live database is used only by the running server.
- The test accounts and their rows were removed by name, in foreign-key order: orders (items, payments,
  events, invoices first), offers (items before offers), warehouses, sellers, sessions, codes, audit rows.
- What remains is what could have happened: 29 accounts (13 demo, 9 agent, 7 people and testers the owner
  created), six shops, five orders, 230 active offers, no tickets, no submissions, no pending payments.

Lesson: a test run that writes to the production database is not a test, it is an incident with a
green build.

## Incident, 2026-10-30: the live PGlite database was damaged

A read-only inspection opened `data/pg` while the Node app had it open. PGlite is one process's
database; the directory became unopenable and the marketplace was down for about 25 minutes.

Recovered as follows:

- `data/pg` left untouched and copied to `data/pg-damaged-backup` (33 MB) before anything else.
- `scripts/restore-backup.mjs` restores a backup into a fresh directory by emptying every table with
  one `TRUNCATE ... RESTART IDENTITY CASCADE` and then re-inserting, so deletion order cannot break
  a foreign key.
- The marketplace now runs on `data/pg-restored` from the newest backup, 2026-10-26: 21 users,
  124 products, 229 offers, 2 orders.

What this cost: the backup is four days old. Rows created after 2026-10-26 - including orders placed
during testing and the renamed demo customer - are not in it. They exist nowhere except the damaged
directory, which is preserved for repair.

The rule that was already written above and was broken twice: while `data/pg` is open in the app,
no other process opens it. Not for a count, not for an inspection, not for an import.

## Step 3 verified (2026-10-30, against equidron_cutover)

The rehearsal database was filled from the real marketplace and served by the Java backend:

    POST /api/shop/login            equidron@gmail.com          -> 200
    GET  /api/shop/orders                                       -> 200, 8 orders
    order 67                     completed, total_paise 22900
    GET  /api/shop/orders/67/invoice                            -> 200, application/pdf, 1108 bytes

That is a real customer, their real history and a real invoice, served from PostgreSQL by the Java
code. A count that matches proves the copy; this proves the copy is usable.

## Two findings from the settings investigation

1. **PGlite cannot be opened by two processes.** Reading the source database while the Node app is
   running aborts the WebAssembly instance. The export in step 1 must run with the Node app stopped,
   or against a copy of `data/pg` - otherwise the cutover reads a database nobody is writing to and
   looks like a crash.
2. **The `settings` table is not business data.** Two rows of site configuration. Rather than special-
   case the encoder for them, they are re-created on the Java side from the same values and excluded
   from the copy, so the import is 53 of 54 tables by intent rather than by accident.

## Step 4 — give Java the secrets

    RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET
    DEEPSEEK_API_KEY
    SMTP_* / MAIL_FROM        (email)
    KYC_PROVIDER / KYC_API_KEY
    SHIPPING_PROVIDER / SHIPPING_API_KEY

Until these are set, the Java side runs simulated - which is a correct choice, but it must be a
*known* one, not a surprise on the first real payment.

## Step 5 — point the browser at Java

Java already serves the AngularJS files, so the storefront, Seller Central and Ops work on one origin:

    http://localhost:8080/shop/     http://localhost:8080/seller/     http://localhost:8080/ops/

The cookie name and the session table are shared, so a person signed in before the cutover stays signed
in after it.

## Step 6 — stop the Node writer

Only after steps 1-5 are checked. Two writers against two databases is the state that loses orders.

## Rollback

One line: point the browser (or the proxy) back at `http://localhost:8010`. The Node database was never
written to during the cutover, so it is intact by construction. That is the reason step 1 is an export
and not a move.

## What is still missing, stated plainly

- The importer script does not exist yet; it is the next piece of work.
- The Java database currently holds demo rows that must be removed or reconciled before real data
  lands, or customers will see two of everything.
- Email is not yet wired on the Java side; a cutover without it means order confirmations stop.

## The four lost days were recovered, 2026-10-31

The damaged cluster was repaired and the missing orders are back in the live database.

How, on COPIES only (the original `data/pg-damaged-backup` was never opened by anything writable):

1. `PG_VERSION` was 16, so the installed PostgreSQL was tried first - and refused with
   `database cluster was initialized without USE_FLOAT8_BYVAL`. That is the decisive fact: PGlite's
   Postgres is compiled differently from the Windows one, so only PGlite can ever open this cluster.
2. PGlite with `debug: 1` printed the real fault that the bare abort had hidden:
   `invalid checkpoint record / could not locate a valid checkpoint record` - a torn write-ahead log.
3. `pg_resetwal -f` on a copy rebuilt the log and the control file, and PGlite then opened it:
   23 users, 8 orders, 229 offers.
4. The four completed orders (36, 37, 38, 67) were merged into the live database by
   `scripts/merge-recovered-orders.mjs`, which re-links rows through values instead of ids: the owner by
   email, the seller and warehouse from the live offer. Two orders whose payment was only "created"
   (34, 35) were deliberately left out.

Verified through the API: the owner's account shows six orders, and every one has an invoice PDF.

The lesson worth keeping: a bare "Aborted()" from a WASM Postgres is not a diagnosis. Turning on the
server's own logging named the fault in one line, and the repair was then ordinary.

## Node stopped, 2026-10-31

The Node server on :8010 was stopped. Java on :8080 is now the only marketplace, the only writer, and the
only thing a browser talks to.

What is kept, so this is reversible:

- `data/pg-restored` - the Node database as it was left (30.5 MB), untouched.
- `data/pg-damaged-backup` - the damaged directory, preserved for repair (31.4 MB).

Rollback is still a change of address, not a restore: start Node again against that folder and point the
browser back at :8010.

    node --use-system-ca app.js --db data/pg-restored --port 8010

Nothing writes to it in the meantime, which is what makes the rollback safe to keep for a few days.
