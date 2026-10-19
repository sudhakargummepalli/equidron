# Equidron (Node.js + PostgreSQL)

A marketplace app in the style of Amazon, with three separate interfaces:

| Interface | URL | Who uses it |
|---|---|---|
| **Store** | http://localhost:8000/shop/ | Customers: search, compare seller offers, cart, checkout, orders, returns, support |
| **Seller Central** | http://localhost:8000/seller/ | Sellers: inventory, add/edit listings, dispatch their own orders, payments ledger |
| **Equidron Ops** | http://localhost:8000/ops/ | Internal staff: approve listings, move shipments through logistics, process returns, answer support, run seller settlement |

> **Sample data.** Every seller, brand, product, customer and order in the seed (`src/sample-data.json`) is fictional and flagged `is_sample`. All three interfaces show a banner saying so. **Payments are simulated.** The app never accepts, handles or stores card numbers.

## Run it locally

Needs **Node.js 22 or newer**. The database is **PostgreSQL**. The pages load AngularJS 1.8.3 from cdnjs, so the browser needs internet access.

```bash
npm install
node app.js
```

Then open http://localhost:8000/. Options: `--port 8080`, `--db <folder or postgres:// URL>`, and `--reset` (drop Equidron's tables and reload the sample data).

With no database URL, the app runs PostgreSQL itself through [PGlite](https://pglite.dev), which is real PostgreSQL compiled to WebAssembly and running inside Node. You don't need a database server, and data is kept in `data/pg/`. The first start takes a few seconds while it creates the tables and loads the sample data.

### Use a PostgreSQL server

Set `DATABASE_URL`, or pass the URL to `--db`. The app creates its tables and loads the sample data on first start.

```bash
DATABASE_URL="postgres://user:password@localhost:5432/equidron" node app.js
```

In PowerShell: `$env:DATABASE_URL = "postgres://user:password@localhost:5432/equidron"; node app.js`. Hosted databases (Neon, Supabase, Netlify DB) usually need `?sslmode=require` on the end of the URL. `--reset` drops only Equidron's own tables.

On this machine Node is a portable install at `%LOCALAPPDATA%\Programs\node-v24.21.0-win-x64`. If `node` isn't on your PATH, run it from PowerShell like this:

```bash
& "$env:LOCALAPPDATA\Programs\node-v24.21.0-win-x64\node.exe" app.js
```

### Demo accounts (password `equidron-demo`)

| Role | Email |
|---|---|
| Customer | `asha@example.com` (Bengaluru), `rahul@example.com` (Delhi) |
| Seller | `lakshmi.seller@example.com`, `techbazaar.seller@example.com`, `urbancart.seller@example.com`, `greenleaf.seller@example.com`, `pageturner.seller@example.com` |
| Ops staff | `ops@example.com` (admin), `support@example.com` (support only), `finance@example.com` (finance only) |

The sample accounts and their shared password work only in **demo mode**, `EQUIDRON_SEED_DEMO=1`. `node app.js` turns it on; set `EQUIDRON_SEED_DEMO=0` to see the app as it behaves anywhere else, where sample accounts can't sign in. On Netlify, set `EQUIDRON_SEED_DEMO=1` under **Site configuration → Environment variables** for a demo site, and leave it unset for a real one.

Each sign-in page has buttons that fill these in (in demo mode). Customers can also create their own accounts: the store emails a 6-digit code to confirm the address. Email isn't connected yet (Phase 10), so the message waits in **Ops → Outbox**, which only admins can open.

## Run the tests

```bash
node --test
```

The tests run on PGlite, so no database server is needed. The sample data is loaded once and restored before every test, so a run takes about 10 seconds.

59 tests cover:
- search ranking and multi-seller offers
- listing review rules and role separation
- checkout revalidation, and payment authorization versus capture
- inventory reservation and warehouse splitting
- cancellation and cash on delivery
- returns, refunds and seller settlement
- a full customer order over real HTTP
- the database layer: placeholders, ids from inserts, rollback
- the Netlify function handler
- bank-statement payment checks: every matching rule, refunds and the checkout API
- the store assistant's tool loop, order privacy, input limits and daily question cap (with a stand-in for the AI model)
- the Seller Central assistant's lookups, which only ever see the signed-in seller's own data

See [DEMO.md](DEMO.md) for a click-by-click walkthrough of the seller and customer flows.

## Deploying to Netlify

On Netlify the app uses **Netlify Database**, Netlify's managed PostgreSQL:
- Netlify provisions the database because `@netlify/database` is a dependency. Netlify Database needs a credit-based Netlify plan.
- On every deploy, Netlify applies the SQL files in `netlify/database/migrations/`. `20261017000000_initial_schema.sql` creates the tables. It is generated from `SCHEMA` in `src/db.js`, and a test checks that the two match. To change the schema, add a new migration file. Never edit an applied one.
- The function reads the connection string from Netlify (`NETLIFY_DB_URL`) and loads the sample data on its first request.

To use another PostgreSQL server instead (Neon, Supabase, RDS), set `DATABASE_URL` under **Site configuration → Environment variables**. The app then creates its own tables. Prefer the provider's *pooled* connection string when it offers one. With neither database, the API answers 503 "not connected to a database yet". Functions have no lasting disk, so the in-process PGlite isn't used there.

The function opens a small connection pool per instance. Every request is a normal database transaction, so concurrent writes from many instances are safe.

Setup:
1. Push this folder to a GitHub repository. `data/` and `node_modules/` are git-ignored.
2. In Netlify: **Add new site → Import from Git** and pick the repo. `netlify.toml` already sets the publish directory, the function and `NODE_VERSION = 22`.
3. Deploy, then open `https://<your-site>.netlify.app/`. It redirects to `/shop/`.

The Netlify runtime itself couldn't be tested from this machine, because the Netlify CLI isn't installed. The function's handler is covered by `tests/postgres.test.js`. The `pg` driver was checked against a PostgreSQL network endpoint, with the full seller flow and concurrent writes.

## How it works

```
app.js                    local server entry point
src/
  db.js                   PostgreSQL schema, query helpers, transactions; pg driver or in-process PGlite
  auth.js                 PBKDF2 password hashing, role-scoped sessions
  catalog.js              search ranking, product pages, featured offer, delivery promise
  assistant.js            chat loop shared by both assistants (Claude via the Anthropic SDK), and the store assistant
  seller-assistant.js     Seller Central assistant: listing rules plus read-only lookups of the seller's own data
  listings.js             seller submissions: validation, auto-approve vs review, approval
  orders.js               cart, checkout, payments, fulfilment, shipments, returns, settlement, support
  payments.js             simulated payment provider (tokens only, never card numbers)
  notify.js               in-app notifications
  seed.js                 loads src/sample-data.json
  api.js                  JSON API routes, independent of the HTTP layer
  server.js               local HTTP server (node:http) + static files
  fetch-handler.js        the API for Fetch-style runtimes (Netlify), with a pooled database connection
netlify/functions/api.mjs Netlify Function entry point
static/                   AngularJS front ends: shop/, seller/, ops/, common/
tests/                    node:test suites
```

### Database access
Columns have real types: times are `TIMESTAMPTZ` (stored in UTC, shown in India time), the delivery promise is a `DATE`, JSON fields are `JSONB` and flags are `BOOLEAN`. Calendar days (return windows, delivery promises, the assistant's daily limit) are India days (`indiaDate()` in `db.js`). Queries are written with `?` placeholders, which `db.js` numbers as `$1, $2, ...` before sending. It also turns `LIKE` into `ILIKE`, so searches ignore case, and adds `RETURNING id` to inserts so the new row's id comes back. Each API request runs as one transaction (a failed sign-in answers with the error instead of throwing it, so the attempt is still recorded). Transactions run side by side; there is no global lock. Code that reads and then writes locks only those rows: checkout reserves stock with a guarded update (`reserved = reserved + n` only while `on_hand - reserved >= n`, in offer and warehouse order so two checkouts can't deadlock), and listing decisions, cancellations, shipment stages and refunds lock their row with `SELECT ... FOR UPDATE`. Settlement and the first-start seed take named locks (`lockNamed` in `db.js`). Checkout also takes an `idempotency_key`, so the same order sent twice is placed once. The concurrency tests run against a real PostgreSQL server in CI.

### Roles are kept separate
Each interface has its own login endpoint, session role and cookie (`eq_shop`, `eq_seller`, `eq_ops`), scoped to its own API path. A seller's session is rejected by the store API and the other way round. Signing in to the wrong interface gives "This account can't sign in here". POST requests must be JSON, which blocks cross-site form posts.

### Accounts, staff permissions and the audit log
- **Passwords** are hashed with scrypt. Accounts from before used PBKDF2 and are re-hashed at their next sign-in.
- **Sessions:** the database keeps only a SHA-256 hash of each token. Every sign-in issues a new token, and **Sign out of all devices** ends every session of the account. On Netlify the cookies are `Secure`.
- **Lockout:** five failed sign-ins in 15 minutes lock that email for 15 minutes (`login_attempts`).
- **Codes by email** confirm a new customer's address and reset a forgotten password (any interface: *Forgot your password?*). A code works once, expires after 30 minutes, and stops after five wrong tries. A reset signs the account out everywhere.
- **Two-step sign-in:** sellers and staff can add an authenticator app under **Security** (TOTP, built on `node:crypto`). Each code works once.
- **Staff permissions:** `support` (support and returns), `catalog` (listing review), `logistics` (shipments), `finance` (settlement) and `admin` (everything, plus Staff, Audit log and Outbox). An Ops route that isn't given a permission needs admin. Admins change permissions on **Ops → Staff**, but can't remove their own admin.
- **Agent accounts** (role `agent`) let agents act as themselves in the audit log. No sign-in page accepts them, and no interface accepts a session for one.
- **Audit log:** service functions record who did what (`audit_log`, with before and after), and any other write request gets one row for itself. Listing decisions and returns record `decided_by`, and Ops shows who decided. **Ops → Audit log** lists the latest 200, masked.
- **Masking:** `mask()` (`src/mask.js`) hides emails, UPI ids, phone numbers, PAN, card and bank numbers. Every log line goes through it, and so will anything sent to an AI agent.
- **Security headers** (Content-Security-Policy without eval, HSTS, nosniff, no framing) come from `netlify.toml` on Netlify and from `src/security-headers.js` locally; a test keeps them the same. AngularJS is pinned with Subresource Integrity.

### Seller listings and approval
Sellers never edit live data. Every save becomes a **submission**:
- **Approved automatically:** stock changes, handling time, and price changes of 20% or less.
- **Held for review:** new products, new offers on existing products, content changes (title, brand, category, description, specs, images), price changes over 20%, and text with restricted terms ("replica", "first copy" and similar).
- Hard validation errors (bad price, price above MRP, missing images, non-https image links, unknown category) are rejected straight away with per-field messages.

The live listing stays unchanged until Ops approves. Approval publishes it to the store and notifies the seller.

### Search ranking
`score = 0.55 × relevance + 0.20 × availability + 0.15 × customer experience + 0.10 × delivery speed`
- *Relevance:* weighted matches in title, brand, category, specs and description, with synonyms (phone, smartphone, mobile) and an accessory penalty, so "phone" shows phones before chargers.
- *Availability:* in stock and deliverable to the chosen city. Out-of-stock items sink to the bottom.
- *Customer experience:* product rating weighted by review count, plus the best seller rating.
- *Delivery speed:* based on the featured offer's delivery estimate.

Tick "Show ranking factors" on the results page to see each product's numbers.

The database picks the candidates: a full-text index (`products_search`) matches each word as a prefix, with its synonyms, and the ranking above orders them. When few products match, `pg_trgm` adds near spellings, so "labtop" finds laptops (only where the server has that extension; otherwise typos simply find nothing). Results come in pages (`page`, `page_size` up to 60, `total`), with Previous and Next in the store.

The sample catalogue has 124 products, 102 of them laptops (budget, thin and light, business, gaming, creator and 2-in-1) from eight fictional brands, sold by TechBazaar, Lakshmi and UrbanCart. A database seeded before the laptops existed gets them from the migration `20261017120000_sample_laptops.sql`.

### Multiple sellers, one product
A product (catalogue page) has many **offers**, one per seller and condition. The **featured offer** is the best new-condition offer, chosen by price with adjustments for slower delivery and weaker seller rating.

### Cart and checkout revalidation
The cart shows an *estimated* total and reserves nothing. Placing the order re-checks every line inside one database transaction:
- the offer is still active
- the price is unchanged; if it changed, the cart is updated and the customer reviews it again
- enough stock is available
- the seller delivers to the address's city

Any problem returns HTTP 409 with the list of issues, and no order is created.

### Orders: payment and fulfilment are separate
An order has three independent statuses: `status`, `payment_status` and `fulfilment_status`.

| Payment method | At checkout | When a shipment ships | On delivery | Cancel / return |
|---|---|---|---|---|
| Card (`tok_sim_…`) | authorize | capture that shipment's amount | – | void the authorization / refund |
| UPI (`upi_sim_…`) | authorize + capture | – | – | refund |
| Cash on delivery | amount due | – | collect | nothing to collect / refund to Equidron balance |

A declined payment records the order as `payment_failed`, releases reserved stock and keeps the cart.

### Bank-transfer payments checked against a bank statement
Besides the simulated options, a customer who has already paid by UPI or bank transfer can choose **"Already paid by UPI or bank transfer"** at checkout and enter the payment reference (UTR / RRN). The order is confirmed only when Equidron's bank statement shows that reference with:
- status `SUCCESS`, and not reversed later (no `REVERSED` row pointing at it)
- a credit of exactly the order total
- no earlier order having used it, even one that was later cancelled and refunded

Otherwise the order is declined with the reason ("still pending", "was ₹1,000.00, but this order is ₹1,099.00", "already used for order #4"), and the cart is kept. Payment is marked captured at once, and a cancellation refunds it.

The statement is read from a Google Sheet published as CSV:
1. In Google Sheets, **File → Import → Upload** `sample-bank-statement.csv`, or keep your own sheet with columns named `Reference…`, `Credit…`, `Status` and `Narration`.
2. **File → Share → Publish to web**, choose that sheet and **Comma-separated values (.csv)**, then copy the link.
3. Set it as `PAYMENT_STATEMENT_CSV_URL` (in Netlify, under **Site configuration → Environment variables**). The app re-reads the sheet at most every 30 seconds.

Without that variable, the app uses the bundled sample statement (`src/sample-statement.js`, the same data as `sample-bank-statement.csv`). Every name, account and reference in it is fictional. **Publish to web makes the sheet readable by anyone with the link**, which is fine for this sample data but not for a real bank statement. Real data would need the Google Sheets API with a service account, or the bank's own API.

### Inventory and warehouses
Stock is held per offer per location: Equidron fulfilment centres (Bengaluru, Hyderabad, Mumbai, Delhi) or a seller's own dispatch location. At checkout, stock is **reserved** at the nearest location that has it (same city first), and an order splits into several shipments when needed. Shipping removes it from `on_hand`. Cancelling releases the reservation, and a restocked return adds it back.

### Shipments
`pending → picking → packed → shipped → in_transit → out_for_delivery → delivered`
Sellers move their own self-ship orders through picking, packing and shipping. Equidron Ops (the logistics simulator) moves fulfilment-centre orders and all carrier stages. Every step is logged and shown to the customer, with notifications at shipped, out for delivery and delivered. Customers can confirm receipt.

### After-sales
- **Returns** are available for 10 days after delivery (grocery is not returnable). A request schedules a pickup. When Ops marks the item received, the customer is refunded to the original payment method, stock is restocked if sellable, and the seller's ledger is debited.
- **Support:** customers open tickets, optionally linked to an order, and Ops replies.
- **Assistant:** signed-in customers can chat with the store assistant from the "Ask Equidron" button. It runs on Claude (`claude-opus-5-5`, low effort; set `EQUIDRON_ASSISTANT_MODEL` to change it) and looks up products, offers and the customer's own orders through read-only tools. It can't place, cancel or return orders, so it points customers to the right page. Each customer can ask up to 30 questions a day (set `EQUIDRON_ASSISTANT_DAILY_LIMIT` to change it; counts are kept in the `assistant_usage` table), after which the chat says to come back tomorrow, so one account can't run up AI costs. On Netlify the AI Gateway supplies the credentials, and usage is billed to the team's Netlify credits. Locally, set `ANTHROPIC_API_KEY` to try it; without a key the chat says it's unavailable.
- **Seller assistant:** signed-in sellers get a "Seller help" chat in Seller Central. It knows the listing rules (what is approved automatically, what goes to review, field limits, fees and settlement), and it looks up the seller's own listings, submissions and review notes, order lines to dispatch, and ledger. It can also compare a product's live offers. It can't edit or submit anything. It shares the store assistant's model, credentials and daily question limit.
- **Voice chat (store and Seller Central):** both chats have a 🎤 button: speak a question and it is sent when you stop talking. Spoken questions get a short answer read aloud. "Read replies aloud" also speaks answers to typed questions, and "Hands-free" listens again after each spoken reply, for a back-and-forth conversation. It uses the browser's Web Speech API in Indian English (`en-IN`), so there is no extra server or cost. Speech input works in Chrome, Edge and Safari but not Firefox, where the mic button is hidden. In Chrome and Edge the browser sends the audio to its own speech service to turn it into text.
- **Telugu (both chats):** an EN / తెలుగు switch in each chat (remembered per browser) changes the panel text, the assistant's replies (Telugu script; product titles and page names stay as shown on screen), voice input (`te-IN`) and read-aloud. A Telugu question gets a Telugu answer even in English mode. Reading replies aloud in Telugu needs a Telugu voice on the device. Edge has one built in, but Chrome on Windows may not, and then the chat says so and shows replies as text. The rest of the store, Seller Central and the server's error messages are still in English. Both chats share one panel (`static/common/chat.html`) and one controller helper (`AssistantChat` in `static/common/common.js`).
- **Seller settlement:** delivered sales credit the seller (minus a 10% referral fee) and refunds debit it. "Run settlement" in Ops pays out positive balances (simulated).

### Events, background jobs and monitoring
Things now happen without anyone clicking.
- **Events:** service functions write an event (`order.placed`, `shipment.status_changed`, `return.requested`, ...) in the same transaction as their change (`src/events.js`).
- **Jobs:** every minute the tick turns new events into jobs, one per listener, never twice, and queues the shipment simulator (every five minutes) and the weekly backup. The worker runs ready jobs; a failing job waits 1, 2, 4 ... minutes and after its last try is **dead** until someone retries it in **Ops → System** (`src/jobs.js`, `src/job-kinds.js`).
- **Today's jobs:** the order confirmation email (to the outbox), the shipment simulator, and a weekly backup of every table as JSON (Netlify Blobs, or `data/backups/` locally), which restores into an empty database (`src/backup.js`).
- **Where it runs:** on Netlify, `netlify/functions/tick.mjs` is a scheduled function (production deploys only) and `netlify/functions/worker-background.mjs` a background function, started by the tick with `WORKER_SECRET` (at most two copies). Locally, `node app.js` runs the same tick in its own process (`--no-jobs` turns it off).
- **Monitoring:** every API answer has an `X-Request-Id`; log lines are masked JSON with that id; errors go to `error_log` (Ops → System) and to Sentry when `SENTRY_DSN` is set. `GET /api/health` reports the database, the queue and the last tick, for an uptime check.
- **Switches** in Ops → System: pause all jobs, and the shipment simulator.

Environment variables for this, set in Netlify (never in code): `WORKER_SECRET` (any long random text; without it, jobs are queued but not run), `SENTRY_DSN` (optional), `EQUIDRON_BACKUP_DIR` (local only, optional).

## Limits and next steps
- Search ranks every match in Node after the index narrows them, which is fine for thousands of products; a much larger catalogue would rank in SQL too.
- AngularJS 1.x is end-of-life and is used here because it needs no build step. A production build would move to modern Angular.
- Product images are generated placeholders. Sellers can add their own `https://` image links.
