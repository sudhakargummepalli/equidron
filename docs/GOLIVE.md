# Go-live checklist (EQ-115)

Everything on this page is either done or needs something only the owner can supply. Nothing here is code
that an agent can finish alone.

## Done

- [x] Security headers on every response (CSP, no framing, no sniffing, limited referrer and sensors), with a
  test that asserts them - `java-backend/src/main/java/in/equidron/SecurityHeaders.java`.
- [x] `robots.txt` keeps the demonstration marketplace out of search engines.
- [x] Database backup script with retention - `scripts/backup-equidron.ps1`; restore steps in `CUTOVER.md`.
- [x] The marketplace runs on PostgreSQL with the same schema and migrations as the Node server.
- [x] Payments in Razorpay test mode, verified against the real API, with idempotent webhooks.
- [x] Invoices with GST split (CGST/SGST/IGST), numbered by month.
- [x] Account lockout after five failed sign-ins, and a sign-in audit trail.
- [x] Data rights: a customer can export their data and delete their account.

## Needs the owner

- [ ] **Legal identity** in `static/legal/*.html`: `[COMPANY NAME]`, `[ADDRESS]`, `[GSTIN]`, `[EMAIL]`,
  `[CITY]`. Until these are filled, the pages say plainly that they are placeholders.
- [ ] **GST registration** decides the invoice tax split. The code already handles both cases; the CA decides
  which applies.
- [ ] **A real email provider.** Gmail with an app password works for testing and will rate-limit customers;
  set `SMTP_*` to the provider's values.
- [ ] **Razorpay live keys** after the GST and legal review. Until then payment runs in test mode.
- [ ] **A hostname and TLS.** Everything currently answers on `localhost`; a reverse proxy or a server with a
  certificate is the step that makes it reachable by anyone else.
- [ ] **WhatsApp business number and approved templates** if the WhatsApp channel is wanted; email and
  in-app messages work without it.
- [ ] **Staff permissions table** if reviewers must not see money or agent controls: today `admin` is granted
  by address in `StaffPermissions`, which is the interim shape.
- [ ] **A specialist review of the four recovered days** if any doubt remains; the damaged cluster is kept.

## Before the first real order

1. Replace the sample data (`EQUIDRON_SEED_DEMO` off) and confirm `robots.txt` allows crawling.
2. Fill the legal pages and link them from the checkout footer.
3. Run one order end to end with a live key, then refund it, then check the invoice, the ledger and the
   settlement batch agree.
4. Restore a backup into a scratch database and read one order from it.