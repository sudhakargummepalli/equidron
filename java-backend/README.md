# Equidron on Java — the plan, and the honest size of it

The Node backend is **~22,000 lines across 40 modules, with 364 tests**. A faithful Java rewrite is a
multi-week project, not a single sitting. This folder is the first slice and the plan, so the work is
visible and reviewable rather than promised.

## Two hard constraints, first

1. **The database.** The Node app uses **PGlite** — PostgreSQL compiled to WebAssembly, running inside
   the Node process. No Java process can open `data/pg`. A Java backend needs a real PostgreSQL server;
   `docker-compose.yml` here starts one. The **schema does not change**: both sides read the same
   `netlify/database/migrations/*.sql`, so they can never drift.
2. **The toolchain.** This machine has Java 17 but **no Maven, Gradle or Docker**. Until one is
   installed, this code cannot be compiled — that is a fact about the machine, not about the code.

## What is here now

| File | Purpose |
|---|---|
| `pom.xml` | Spring Boot 3.3, Java 17, JDBC, Flyway, PostgreSQL driver |
| `ApiApplication.java` | the entry point |
| `HealthController.java` | `GET /api/health`, shaped exactly like the Node one |
| `application.yml` | datasource from `DATABASE_URL`, Flyway pointed at the existing migrations |
| `docker-compose.yml` | a real PostgreSQL 16 for the Java side |

## The plan: a strangler, not a rewrite in place

Rewrite in place means the marketplace is broken for weeks. Instead the Node app keeps serving while
Java takes over **one endpoint group at a time**, with the same URLs, the same JSON and the same
database. A reverse proxy (or Netlify routing) sends a path to whichever side owns it that week.

| Step | Slice | Why in this order | Effort |
|---|---|---|---|
| 0 | health, config, Flyway against the shared migrations | proves the foundation | done |
| 1 | auth: scrypt login, sessions, cookies | everything else needs a session | 1–2 days |
| 2 | catalog: search, product detail, offers, delivery promise | read-only, no money | 2–3 days |
| 3 | cart + checkout + orders | the writing heart, needs locking care | 3–4 days |
| 4 | seller: listings, submissions, orders, payouts | second audience | 3 days |
| 5 | ops: incidents, analytics, approvals, settlement | staff, internal | 3–4 days |
| 6 | agents + jobs (the queue, tools, policy) | the hardest part; largest surface | 1–2 weeks |
| 7 | payments, shipping, KYC adapters | already provider-shaped, so mechanical | 2–3 days |
| 8 | invoices, legal pages, data rights | small, self-contained | 1 day |

**Front end: keep it.** AngularJS 1.8 talks to `/api/...` over HTTP and knows nothing about the server's
language. Rewriting it at the same time would double the risk for zero functional gain. Change the
backend behind it, prove the parity, and only then decide whether the browser code is worth a second
life. (If it ever is, the cheapest honest move is a static SPA over *these* JSON endpoints.)

## Parity, measured not claimed

The Node suite is the specification. Each Java slice ships with tests that reuse the same **golden data**
and the same expected JSON, so "ported" means "the same responses", not "compiles".

```text
tests/            the Node specification, 364 cases
java-backend/src/test/...   the same cases, ported as the slice lands
```

## To run it (once the toolchain exists)

```powershell
winget install Apache.Maven            # and Docker Desktop, or a local PostgreSQL 16
cd java-backend
docker compose up -d                   # a real PostgreSQL
mvn spring-boot:run                    # http://localhost:8080/api/health
```

## What I need from you to continue

1. **Install Maven** (`winget install Apache.Maven`) — without it I cannot compile or test, and I will
   not hand you code I have never run.
2. **Pick the next slice**: `auth` is the honest choice, because nothing else works without it.
3. Decide the end state: **strangler** (both run, Java takes over gradually — recommended) or
   **big-bang** (Java replaces Node in one release, with the marketplace down meanwhile).