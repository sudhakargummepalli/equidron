# Equidron demo walkthrough (about 10 minutes)

Start fresh with `node app.js --reset` (or `npm run reset`). Use three browser tabs, or a normal window and a private one: logins are separate per interface, so all three can stay signed in together. Every password is `equidron-demo`. All data is sample data.

## Part 1: Seller lists and updates products

1. Open **http://localhost:8000/seller/** and click **TechBazaar Hub**, then **Sign in**. The dashboard shows active listings, items in review, orders to dispatch and the unsettled balance.
2. **Inventory → Edit** on *Bassline Mini Bluetooth Speaker*.
   - Change **Available quantity** to `75` and click **Save and submit**. You'll see *"Saved and live"*: stock changes are approved automatically.
   - Edit it again and change **Price** from 1499 to `999`. You'll see *"Submitted for review… Price changed by 33%"*. The store still shows ₹1,499.
3. **+ Add a product → search "Orbit Nova" → Sell this** adds an offer to an existing product page. Or click **Create a new product page instead** and fill in title, brand, category, description, specs and an `https://` image. Try a price above the MRP or an `http://` image to see the field errors. New listings always wait for review.
4. Open **http://localhost:8000/ops/** and click **ops@example.com**, then **Sign in**. **Listing review** shows each held submission: why it was held, and live vs proposed values side by side (changes highlighted).
   - **Approve & publish** the price change. Back in Seller Central, **Submissions** shows it approved and **Alerts** has the notification.
   - Reject the seeded *Kestrel K20 5G* with a note. It never appears in the store.

## Part 2: Customer search, compare, buy

5. Open **http://localhost:8000/shop/**, click **Sign in**, then **asha@example.com** and **Sign in**. Deliver to: **Bengaluru**.
6. Search **phone**. Phones rank above the charger and case, and the out-of-stock *Kestrel K12 Lite* sinks to the bottom as "Currently unavailable". Tick **Show ranking factors** to see relevance, availability, experience and speed. Switch Deliver to **Chennai**: the Zenix Fold becomes "Not deliverable".
7. Open **Orbit Nova X5 5G**: three sellers, one renewed. The **Featured offer** is highlighted, and each offer shows its seller rating, who ships it, stock and delivery date. Click **Add to cart** on one.
8. **Cart** shows the *estimated* total and free-delivery threshold. Click **Proceed to checkout**.
9. **Checkout** re-checks the cart when it loads. To see revalidation, keep this tab open, change that offer's price in Seller Central and approve it in Ops, then click **Place your order**. You get "Your cart changed…" with the old and new price, and must review again.
10. Payment is simulated. Choose **Simulated card that is declined** and place the order: payment is declined, nothing is charged, and the cart is kept. Choose **Simulated Visa ending 4242** and place the order again.
11. The order page shows three separate statuses: **Order: Confirmed · Payment: Authorized · Fulfilment: Not started**. The Payment panel shows authorized ₹X and captured ₹0. You can **Cancel order** now, and the authorization is voided.

## Part 3: Fulfilment, shipping, delivery

12. In **Ops → Fulfilment & shipping**, click **→ Picking**, then **→ Packed** (a tracking number is assigned), then **→ Shipped**. On the customer's order the stage tracker moves forward, **Payment** becomes **Captured** when it ships, the **Cancel** button disappears, and an alert arrives. **Simulate: advance all one stage** moves every open shipment forward at once.
13. Continue to **In transit → Out for delivery → Delivered**. The order becomes **Completed / Delivered**. The customer can click **Confirm I received this**.
14. Self-ship items, such as *Kitchora Mixer Grinder* from GreenLeaf, are picked, packed and shipped by the seller in **Seller Central → Orders** (sign in as greenleaf.seller@example.com). After that the carrier stages belong to Ops.
15. Try **Cash on delivery** on another order: payment stays **Cod pending** until the Delivered step collects it.

## Part 4: After-sales

16. Asha's seeded order #1 is already delivered. Open it and click **Return item** on the earbuds, choose a reason, then **Request return**. Pickup is scheduled and the seller is notified. Grocery items show "This item is not returnable".
17. In **Ops → Returns**, click **Received, restock & refund**. The customer sees **Payment: Partially refunded** and gets a refund alert. Stock goes back up, and the seller's **Payments** ledger shows the refund debit and the fee reversal.
18. **Customer service** (store): open a ticket for the order. Reply from **Ops → Support** and the customer is notified.
19. **Ops → Settlement → Run settlement now** pays each seller's positive balance (sales minus the 10% fee minus refunds). It appears as a *Payout* in the seller's ledger.

## Role separation check
- Try signing in to the store with `techbazaar.seller@example.com`: you get *"This account can't sign in here. Please use Seller Central."*
- A customer session can't call `/api/seller/*` or `/api/ops/*`. Each API has its own cookie and returns 401.

## Part 5: Accounts, staff permissions and the audit trail
20. **Sign up with a code.** In the store, **Sign in → New to Equidron? Create an account** with any made-up name, a fake `@example.com` email and a password. The page asks for a 6-digit code. In Ops (as `ops@example.com`), open **Outbox**: the code waits there because email isn't connected yet. Enter it in the store and you're signed in.
21. **Forgotten password.** In any sign-in page, **Forgot your password?** sends a code to the Outbox. Use it with a new password: the code works once, and every other session of that account ends.
22. **Lockout.** Sign in to the store as `rahul@example.com` with a wrong password five times. The sixth try, even with the right password, says *"Too many failed sign-ins"*. It opens again after 15 minutes, or at once after a password reset.
23. **Staff permissions.** Sign out of Ops and sign in as `support@example.com`: only Returns and Support show, and running settlement is refused. As `ops@example.com`, open **Staff**, tick `finance` for Priya and **Save**. The change shows in the **Audit log**.
24. **Who decided.** Approve or reject a listing, then look at it under **Approved** or **Rejected**: it says who decided. Returns show it too. **Audit log** lists every change with before and after, emails masked.
25. **Two-step sign-in.** In Seller Central (or Ops), open **Security → Set up an authenticator app**, add the key to an app such as Google Authenticator, and enter its code. Sign out and in again: now the page asks for the app's code too. Turn it off the same way.
26. **Sign out everywhere.** Sign in to Seller Central in two browsers, then **Security → Sign out of all devices** in one: both are signed out.

## Part 6: Things that happen on their own
27. Start the app (`node app.js`) and place an order in the store. Within a minute, **Ops → Outbox** has its confirmation email, and **Ops → System** shows the `email:order_confirmation` job as done.
28. Leave the app running: every five minutes the shipment simulator moves each active shipment one stage, without anyone clicking. Turn it off under **System → Switches**.
29. **System → Send a test error**: it appears under *Recent errors* with its request id (and in Sentry, if `SENTRY_DSN` is set).
30. Open **http://localhost:8000/api/health**: the database, the queue and the time of the last tick.

## Part 7: Agents, with a person in charge
This part needs a model: put `ANTHROPIC_API_KEY=...` in a local `.env` (never in git), or run it on Netlify, where the
AI Gateway supplies one. Without credentials everything below still opens and explains itself; a run is refused.

31. **Look at the agents.** In Ops (as `ops@example.com`) open **Agents**. Two agents are listed: *Ops helper* (off) and
   *Store assistant* (on). Each shows its level, model, daily budget and today's spending. **Pause all** is the big red
   button: nothing new starts, and a run that is going stops at its next step.
32. **Shadow first (L1).** Turn *Ops helper* on, leave it at **L1 · shadow**, type a task such as *"Shipment 2 is late.
   Check the order and move it on."* and press **Run once**. Open **Agent runs**: the run has a model step and a tool step;
   the tool step says `shadow` and the shipment has **not** moved. Press it again at L1 and compare: same outcome.
33. **Ask a person (L2).** Set the level to **L2 · propose** and run the same task. The run ends as `waiting` and the action
   appears in **Approvals** with its risk, amount and the agent's reason. **Reject** one: nothing happens. Run again and
   **Approve**: the shipment moves, once. Two people clicking approve at the same time still move it once.
34. **Act within limits (L3).** Set **L3 · act within limits** and run it: the tool step says `execute` and the shipment
   moves without an approval. The run's tokens and its cost in dollars are on **Agent runs**; the daily budget on
   **Agents** goes up by that much. When the budget is spent, the next run stops instead of starting.
35. **The shop chat is an agent too.** Ask the store assistant *"Was my order delivered?"*: the reply arrives as before,
   and a new run appears in **Agent runs** with a `get_my_order` step marked `execute`. Reads never need approval.
36. **Evals.** `node scripts/eval.js ops_helper` is free: it lists the cases and the likely cost. `--yes` calls the real
   model and spends credit; ask before running it.

## Part 8: The first three Ops agents
They ship switched off and at L1 (shadow); a person turns each one on in **Ops → Agents**. Without a model, steps 38
and 40 still fill their lists; with a model, every step below works in full.

37. **Listing Review, in shadow.** In Seller Central, submit a change that will be held (a new product, or a description
   with the word "replica"). In Ops → **Submissions** it waits. Within a minute the agent reviews it: open **Agent runs**
   and find the run with subject `submission:<id>` — a model step, a `get_submission` step, and the JSON verdict. The
   submission is still pending, and **Agents** now shows *Listing Review — no decided cases to compare yet* until a
   person decides it. Decide it, then look again: the agreement score has one case.
38. **Tasks fill themselves.** Make a shipment two days late (or wait): the hourly Fulfilment Watch job opens one item
   under **Ops → Tasks**, saying which shipment and which order. It is opened by SQL, not by the model, so it happens
   whether or not the agent is on. Close it with **Done**; the second click is refused.
39. **Fulfilment Watch's messages, in shadow.** Turn *Fulfilment Watch* on and leave it at L1. On its next hourly run,
   open its run under **Agent runs**: any `nudge_seller` or `warn_customer` step says `shadow`, and no seller or customer
   received anything. At L2 the same messages would appear in **Approvals**; at L3 they would be sent, at most once per
   shipment per day.
40. **The morning brief.** Turn *Daily Brief* on. After 08:00 IST (the tick queues it once a day) open **Agents**: the
   card at the top is that morning's brief, written only from `get_daily_numbers`. Press **Refresh** to see it after the
   run; the same text is the run's summary under **Agent runs**.
41. **The eval set.** `node scripts/eval.js listing_review` is free and lists all 30 cases (good, restricted words,
   price traps, wrong category, five injections). About $0.31 of credit runs them for real with `--yes`.
