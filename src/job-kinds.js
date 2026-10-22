// The kinds of job Equidron runs today. BUILT_IN handlers run inside the job's transaction and
// read fresh data from the ids in the payload. AGENT_KINDS start an agent run: those run
// outside the job's transaction (a run waits minutes on a model), and are marked done after.
import { saveBackup } from './backup.js';
import { getAgent, allPaused } from './agents/agents.js';
import { runAgent } from './agents/runtime.js';
import { tool } from './agents/tools.js';
import { all, changes, indiaDate, loads, one, run } from './db.js';
import * as emails from './emails.js';
import * as orders from './orders.js';
import { sendEmail } from './outbox.js';

export const BUILT_IN = {
  // The confirmation email for a new order (into the outbox until email is connected).
  async 'email:order_confirmation'(db, payload) {
    const o = await one(db, `SELECT o.id, o.total_paise, u.id AS user_id, u.email, u.name,
                                    (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS items
                             FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?`, payload.entity_id);
    if (!o) return;
    const city = (await one(db, 'SELECT city FROM addresses WHERE user_id = ? ORDER BY id LIMIT 1', o.user_id))?.city;
    const msg = emails.orderPlaced({
      firstName: o.name, orderId: Number(o.id), totalPaise: o.total_paise, itemCount: Number(o.items), city,
    });
    await sendEmail(db, o.user_id, o.email, msg.subject, msg.body);
  },

  // One email for each state an order passes through after it is placed: the payment, every
  // courier stage, a cancellation, and the return that may follow a delivery. The event says
  // which state; the handler reads the facts as they are now, so the message matches the page.
  // 'pending' is skipped: the confirmation already said the order was received.
  async 'email:order_event'(db, payload) {
    if (payload.type === 'shipment.status_changed') {
      const s = await one(db, `SELECT s.id, s.status, s.tracking_no, s.eta, s.order_id,
                                      u.id AS user_id, u.email, u.name,
                                      (SELECT city FROM addresses WHERE user_id = o.user_id ORDER BY id LIMIT 1) AS city
                               FROM shipments s JOIN orders o ON o.id = s.order_id JOIN users u ON u.id = o.user_id
                               WHERE s.id = ?`, payload.entity_id);
      if (!s) return;
      // The stage the event reported, not the row's stage now: two changes can be dispatched in
      // one tick, and a second email about the same stage would be a duplicate.
      const stage = emails.STAGE_WORDS[payload.data?.to] ? payload.data.to : s.status;
      if (!emails.STAGE_WORDS[stage]) return;
      const items = await all(db, 'SELECT title, qty FROM order_items WHERE shipment_id = ? ORDER BY id', s.id);
      const msg = emails.shipmentUpdate({
        firstName: s.name, orderId: Number(s.order_id), stage,
        items: items.map((i) => `${i.title} × ${i.qty}`), tracking: s.tracking_no, eta: s.eta, city: s.city,
      });
      await sendEmail(db, s.user_id, s.email, msg.subject, msg.body);
      return;
    }

    if (payload.type.startsWith('return.')) {
      const r = await one(db, `SELECT r.id, r.order_id, r.qty, r.status, oi.title, oi.unit_price_paise,
                                      u.id AS user_id, u.email, u.name
                               FROM returns r JOIN order_items oi ON oi.id = r.order_item_id
                               JOIN users u ON u.id = r.user_id WHERE r.id = ?`, payload.entity_id);
      if (!r) return;
      const facts = { firstName: r.name, orderId: Number(r.order_id), returnId: Number(r.id), title: r.title, qty: r.qty };
      const msg = payload.type === 'return.requested' ? emails.returnApproved(facts)
        : payload.type === 'return.received' ? emails.returnRefunded({ ...facts, refundPaise: r.unit_price_paise * r.qty })
        : emails.returnRejected(facts);
      await sendEmail(db, r.user_id, r.email, msg.subject, msg.body);
      return;
    }

    const o = await one(db, `SELECT o.id, o.total_paise, o.payment_method, u.id AS user_id, u.email, u.name
                             FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?`, payload.entity_id);
    if (!o) return;
    const facts = { firstName: o.name, orderId: Number(o.id), totalPaise: o.total_paise, method: o.payment_method };
    const msg = payload.type === 'payment.captured' ? emails.paymentReceived(facts)
      : payload.type === 'order.cancelled' ? emails.orderCancelled(facts)
      : null;
    if (msg) await sendEmail(db, o.user_id, o.email, msg.subject, msg.body);
  },

  // A seller email when a listing is added or edited, and again when it is decided. The seller is
  // the person who submitted it, so this is a receipt, not a request: it repeats what the page says.
  async 'email:seller_listing'(db, payload) {
    const sub = await one(db, `SELECT s.id, s.kind, s.status, s.review_reasons, s.reviewer_note, s.auto_decided, s.payload,
                                      s.product_id, u.id AS user_id, u.email, u.name
                               FROM submissions s JOIN sellers se ON se.id = s.seller_id
                               JOIN users u ON u.id = se.user_id WHERE s.id = ?`, payload.entity_id);
    if (!sub) return;
    // An update carries only the fields that changed, so its title comes from the product itself.
    const title = loads(sub.payload).title
      || (sub.product_id ? (await one(db, 'SELECT title FROM products WHERE id = ?', sub.product_id))?.title : null)
      || '(untitled listing)';
    const facts = {
      firstName: sub.name,
      title,
      kind: sub.kind,
      approved: sub.status === 'approved',
      note: sub.reviewer_note,
      auto: sub.auto_decided,
    };
    const msg = payload.type === 'submission.created'
      ? emails.listingSubmitted({ ...facts, status: sub.status, reasons: loads(sub.review_reasons) })
      : emails.listingDecided(facts);
    await sendEmail(db, sub.user_id, sub.email, msg.subject, msg.body);
  },

  // The logistics simulator: every active shipment moves one stage, as the Ops button does.
  async 'simulator:advance_shipments'(db) {
    for (const s of await orders.listShipments(db)) await orders.advanceShipment(db, s.id, 'ops');
  },

  // Every table as JSON, kept in Netlify Blobs (or data/backups locally).
  async 'backup:weekly'(db) {
    await saveBackup(db);
  },
};

// An agent that is off, paused, or out of budget is not a failure: the job is simply done and
// the next tick will try again. Returns the agent row when a run may start.
async function ready(db, agentId) {
  const agent = await getAgent(db, agentId);
  if (!agent || !agent.enabled || agent.autonomy_level === 0) return null;
  if (await allPaused(db)) return null;
  return agent;
}

export const AGENT_KINDS = {
  // A submission was held for review: let Listing Review look at it. At L1 its verdict is
  // stored beside the person's (that is the agreement score); at L3 it may decide itself.
  'agent:listing_review': (db, payload) => reviewListing(db, payload.entity_id),

  // Every hour: find late shipments, raise one Ops task for each that is twice as late, and let
  // the agent message the seller or the customer. The task is deliberate SQL, not the model's:
  // that rule must hold whether or not the model notices.
  'agent:fulfilment_watch': (db) => watchFulfilment(db),

  // Once a morning: the brief. Its text is the run's summary, which Ops shows.
  'agent:daily_brief': (db) => writeDailyBrief(db),
};

// The work behind each kind, separately, so tests can hand it a scripted model.
export async function reviewListing(db, submissionId, options = {}) {
  if (!(await ready(db, 'listing_review'))) return;
  const sub = await one(db, 'SELECT id, status FROM submissions WHERE id = ?', submissionId);
  if (!sub || sub.status !== 'pending') return; // already decided by a person, or auto-approved
  // A retried job must not review the same submission twice: skip when a run already finished
  // or is waiting for a person, or is still going. A run left "running" by a worker that died
  // is stale after 20 minutes, and then a retry may take it over.
  const earlier = await one(db, `SELECT 1 AS x FROM agent_runs WHERE agent_id = 'listing_review'
                                 AND trigger = 'event:submission.created' AND subject = ?
                                 AND (status IN ('done', 'waiting')
                                      OR (status = 'running' AND started_at > now() - interval '20 minutes'))
                                 LIMIT 1`, String(submissionId));
  if (earlier) return;

  const out = await runAgent(db, {
    agentId: 'listing_review',
    trigger: 'event:submission.created',
    subject: String(submissionId),
    task: `Submission #${submissionId} is held for review. Read it with get_submission and decide whether it should go live.`,
  }, options);
  const decision = out.decision;
  if (decision) {
    await run(db, `UPDATE submissions SET agent_run_id = ?, agent_decision = ?, agent_confidence = ?, agent_decided_at = now()
                   WHERE id = ?`, out.id, JSON.stringify(decision), Number(decision.confidence), submissionId);
  }
  return out;
}

export async function watchFulfilment(db, options = {}) {
  const today = indiaDate();
  const late = await tool('late_shipments').run(db, { today: new Date() }, {});
  for (const s of late.filter((r) => r.days_late >= 2)) {
    // One task per shipment per day: the dedupe key is the rule. changes(), not run(): an
    // insert that hits the key returns no row, and run() would look for one.
    await changes(db, `INSERT INTO ops_tasks (kind, subject, body, dedupe_key) VALUES ('late_shipment', ?, ?, ?)
                       ON CONFLICT (dedupe_key) DO NOTHING`,
    `shipment:${s.shipment_id}`,
    `Shipment ${s.shipment_id} (order ${s.order_id}) is ${s.days_late} days past its delivery estimate.`,
    `late:${s.shipment_id}:${today}`);
  }
  if (!late.length || !(await ready(db, 'fulfilment_watch'))) return;
  return await runAgent(db, {
    agentId: 'fulfilment_watch',
    trigger: 'schedule',
    subject: `late:${today}`,
    task: `There are ${late.length} shipments past their delivery estimate today. Look at them and do what is right.`,
  }, options);
}

export async function writeDailyBrief(db, options = {}) {
  if (!(await ready(db, 'daily_brief'))) return;
  return await runAgent(db, {
    agentId: 'daily_brief',
    trigger: 'schedule',
    subject: `brief:${indiaDate()}`,
    task: 'Write the morning brief for the owner and the Ops team.',
  }, options);
}
