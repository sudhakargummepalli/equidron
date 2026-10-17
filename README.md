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
| Ops reviewer | `ops@example.com` |

Each sign-in page has buttons that fill these in. Customers can also create their own accounts.

## Run the tests

```bash
node --test
```

The tests run on PGlite, so no database server is needed. The sample data is loaded once and restored before every test, so a run takes about 10 seconds.

33 tests cover:
- search ranking and multi-seller offers
- listing review rules and role separation
- checkout revalidation, and payment authorization versus capture
- inventory reservation and warehouse splitting
- cancellation and cash on delivery
- returns, refunds and seller settlement
- a full customer order over real HTTP
- the database layer: placeholders, ids from inserts, rollback
- the Netlify function handler

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
Queries are written with `?` placeholders, which `db.js` numbers as `$1, $2, ...` before sending. It also turns `LIKE` into `ILIKE`, so searches ignore case, and adds `RETURNING id` to inserts so the new row's id comes back. Each API request runs as one transaction. Write transactions take a lock first, so only one runs at a time. That way checkout can read stock and then reserve it without another order slipping in between. Reads don't take the lock.

### Roles are kept separate
Each interface has its own login endpoint, session role and cookie (`eq_shop`, `eq_seller`, `eq_ops`), scoped to its own API path. A seller's session is rejected by the store API and the other way round. Signing in to the wrong interface gives "This account can't sign in here". POST requests must be JSON, which blocks cross-site form posts.

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

### Inventory and warehouses
Stock is held per offer per location: Equidron fulfilment centres (Bengaluru, Hyderabad, Mumbai, Delhi) or a seller's own dispatch location. At checkout, stock is **reserved** at the nearest location that has it (same city first), and an order splits into several shipments when needed. Shipping removes it from `on_hand`. Cancelling releases the reservation, and a restocked return adds it back.

### Shipments
`pending → picking → packed → shipped → in_transit → out_for_delivery → delivered`
Sellers move their own self-ship orders through picking, packing and shipping. Equidron Ops (the logistics simulator) moves fulfilment-centre orders and all carrier stages. Every step is logged and shown to the customer, with notifications at shipped, out for delivery and delivered. Customers can confirm receipt.

### After-sales
- **Returns** are available for 10 days after delivery (grocery is not returnable). A request schedules a pickup. When Ops marks the item received, the customer is refunded to the original payment method, stock is restocked if sellable, and the seller's ledger is debited.
- **Support:** customers open tickets, optionally linked to an order, and Ops replies.
- **Seller settlement:** delivered sales credit the seller (minus a 10% referral fee) and refunds debit it. "Run settlement" in Ops pays out positive balances (simulated).

## Limits and next steps
- Search loads offers and stock for all matching products in two queries, and shows at most 60 results.
- AngularJS 1.x is end-of-life and is used here because it needs no build step. A production build would move to modern Angular.
- Product images are generated placeholders. Sellers can add their own `https://` image links.
