// The first Ops agents: the columns that keep an agent's verdict next to a person's, the
// ops_tasks work items, and the three agents themselves (Listing Review, Fulfilment Watch and
// the Daily Brief) running on the Phase 4 runtime with a scripted model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { agreement, getAgent, updateAgent } from '../src/agents/agents.js';
import { executeTool, tool } from '../src/agents/tools.js';
import { handleApi } from '../src/api.js';
import { settings } from '../src/auth.js';
import { createUser } from '../src/auth.js';
import { addDays, all, connect, indiaDate, one, run, scalar, SCHEMA, transaction } from '../src/db.js';
import * as jobs from '../src/jobs.js';
import { reviewListing, watchFulfilment, writeDailyBrief } from '../src/job-kinds.js';
import * as listings from '../src/listings.js';
import * as orders from '../src/orders.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

// The seeded shop, for the tool tests: real sellers, listings and shipments.
let shop;
before(async () => {
  shop = await openDatabase('memory');
});
after(async () => {
  await shop?.close();
});

const MIGRATION = readFileSync(new URL('../netlify/database/migrations/20261023000000_ops_agents.sql', import.meta.url), 'utf8');
const BEFORE = 'ALTER TABLE submissions ADD COLUMN IF NOT EXISTS agent_run_id';

async function databaseBeforePhase5() {
  const db = await connect('memory');
  await db.exec(SCHEMA.slice(0, SCHEMA.indexOf(BEFORE)));
  return db;
}

async function aSeller(db) {
  const uid = await run(db, "INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('s@example.com', 'S', 'seller', 's', 'h', now())");
  return await run(db, "INSERT INTO sellers (user_id, name, city) VALUES (?, 'Sample Seller', 'Pune')", uid);
}

const columnType = (db, table, column) => scalar(db,
  'SELECT data_type FROM information_schema.columns WHERE table_name = ? AND column_name = ?', table, column);

test('the Phase 5 migration adds the agent columns and ops_tasks, and can run twice', async () => {
  const db = await databaseBeforePhase5();
  try {
    await db.exec(MIGRATION);
    await db.exec(MIGRATION); // every statement is IF NOT EXISTS, so a second deploy is harmless

    assert.equal(await columnType(db, 'submissions', 'agent_run_id'), 'bigint');
    assert.equal(await columnType(db, 'submissions', 'agent_decision'), 'jsonb');
    assert.equal(await columnType(db, 'submissions', 'agent_confidence'), 'numeric');
    assert.equal(await columnType(db, 'submissions', 'agent_decided_at'), 'timestamp with time zone');
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM ops_tasks'), 0);
  } finally {
    await db.close();
  }
});

test('a submission can hold the agent’s verdict beside the person’s', async () => {
  const db = await databaseBeforePhase5();
  try {
    await db.exec(MIGRATION);
    const seller = await aSeller(db);
    const subId = await run(db, `INSERT INTO submissions (seller_id, kind, payload, status, review_reasons, created_at)
                                 VALUES (?, 'new_product', '{"title":"Sample"}', 'pending', '[]', now())`, seller);
    const runId = await run(db, `INSERT INTO agent_runs (agent_id, trigger, status)
                                 SELECT 'ops_helper', 'event:submission.created', 'done' FROM agents WHERE id = 'ops_helper'`)
      .catch(() => 0); // the agents table may be empty in this bare schema; the column is what matters
    await run(db, `UPDATE submissions SET agent_run_id = ?, agent_decision = ?, agent_confidence = 0.82, agent_decided_at = now()
                   WHERE id = ?`, runId || null, JSON.stringify({ decision: 'reject', reasons: ['replica'] }), subId);
    const s = await one(db, 'SELECT * FROM submissions WHERE id = ?', subId);
    assert.deepEqual(s.agent_decision, { decision: 'reject', reasons: ['replica'] });
    assert.equal(s.agent_confidence, 0.82); // NUMERIC(4,3) arrives as a number
    assert.ok(s.agent_decided_at instanceof Date);
    // A person's decision is separate, and both can be read at once for the agreement score.
    await run(db, "UPDATE submissions SET status = 'rejected', decided_at = now() WHERE id = ?", subId);
    assert.equal((await one(db, 'SELECT status, agent_decision FROM submissions WHERE id = ?', subId)).agent_decision.decision, 'reject');
  } finally {
    await db.close();
  }
});

test('an ops task starts open, can be closed, and a dedupe key stops duplicates', async () => {
  const db = await databaseBeforePhase5();
  try {
    await db.exec(MIGRATION);
    const id = await run(db, `INSERT INTO ops_tasks (kind, subject, body, dedupe_key)
                              VALUES ('late_shipment', 'shipment:12', 'Four days late', 'late:12:2026-10-23')`);
    const t = await one(db, 'SELECT * FROM ops_tasks WHERE id = ?', id);
    assert.equal(t.status, 'open');
    assert.ok(t.created_at instanceof Date);
    await assert.rejects(
      run(db, `INSERT INTO ops_tasks (kind, subject, body, dedupe_key) VALUES ('late_shipment', 'again', 'x', 'late:12:2026-10-23')`),
      /unique|duplicate/i);
    await assert.rejects(
      run(db, `INSERT INTO ops_tasks (kind, subject, body, status) VALUES ('late_shipment', 'x', 'y', 'maybe')`),
      /check constraint/i);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------- Listing Review's tools

test('Listing Review can read a held submission with everything it needs to judge', async () => {
  const product = await one(shop, "SELECT id, title FROM products WHERE status = 'live' ORDER BY id LIMIT 1");
  const seller = await one(shop, 'SELECT id FROM sellers ORDER BY id LIMIT 1');
  const subId = await run(shop, `INSERT INTO submissions (seller_id, product_id, kind, payload, status, review_reasons, created_at)
                                 VALUES (?, ?, 'update', ?, 'pending', ?, now())`, seller.id, product.id,
  JSON.stringify({ title: 'Replica Orbit Nova X5 5G', description: 'First copy of the Orbit Nova. Looks exactly like the original.', price_paise: 1_599_900, mrp_paise: 2_499_900 }),
  JSON.stringify(['Contains restricted terms: replica, first copy.']));

  const facts = await tool('get_submission').run(shop, {}, { submission_id: subId });
  assert.equal(facts.submission_id, subId);
  assert.deepEqual(facts.restricted_terms.sort(), ['first copy', 'replica']);
  assert.match(facts.proposed.price, /15,999/);
  assert.equal(facts.price_vs_mrp_percent, 64); // 15999 / 24999
  assert.ok(facts.review_reasons.some((r) => /restricted terms/.test(r)));
  assert.ok(facts.other_offers.length > 0, 'the same product has other sellers, so prices can be compared');
  assert.ok(facts.other_offers.every((o) => typeof o.price === 'string'));
});

test('decide_submission approves through the same service function people use', async () => {
  const agent = await getAgent(shop, 'listing_review');
  assert.ok(agent, 'the Phase 5 agents exist after openDatabase');
  assert.equal(agent.enabled, false); // switched off until a person turns it on

  const seller = await one(shop, `SELECT s.id FROM sellers s JOIN users u ON u.id = s.user_id
                                 WHERE u.email = 'techbazaar.seller@example.com'`);
  const sub = await transaction(shop, () => listings.submit(shop, seller.id, {
    title: 'Kestrel K20 5G Smartphone (8GB RAM, 256GB, Aurora Purple)', brand: 'Kestrel', category: 'Phones',
    description: 'A mid-range 5G phone with a 64MP camera, a 120Hz display and a 5500 mAh battery.',
    specs: { Display: '6.7-inch AMOLED' }, images: ['https://example.com/k20.jpg'], price: '21999', mrp: '24999',
    quantity: 10, handling_days: 1, fulfilment: 'seller', ships_to: ['ALL'],
  }));
  assert.equal(sub.status, 'pending');

  const out = await executeTool(shop, agent, {
    name: 'decide_submission',
    input: { submission_id: sub.id, approve: true, note: 'Details and price look right.', reason: 'Clean listing' },
  }, `test:${sub.id}:decide`);
  assert.equal(out.result.status, 'approved');
  const after = await one(shop, 'SELECT status, decided_by FROM submissions WHERE id = ?', sub.id);
  assert.equal(after.status, 'approved');
  assert.equal(after.decided_by, agent.user_id); // the agent's own account made the change
});

// ---------------------------------------------------------------- Fulfilment Watch's tools

const TODAY = new Date('2026-10-20T06:00:00Z'); // a fixed India day, so "days late" is exact
const threeDaysAgo = '2026-10-17';

async function aSellerShipment() {
  const asha = (await one(shop, "SELECT id FROM users WHERE email = 'asha@example.com'")).id;
  const address = (await one(shop, 'SELECT id FROM addresses WHERE user_id = ? ORDER BY id LIMIT 1', asha)).id;
  const offer = await one(shop, `SELECT o.id FROM offers o JOIN products p ON p.id = o.product_id
                                 JOIN sellers se ON se.id = o.seller_id
                                 WHERE o.fulfilment = 'seller' AND o.status = 'active' AND p.title LIKE 'Kitchora%'
                                 LIMIT 1`);
  assert.ok(offer, 'a seller-dispatched offer exists in the sample data');
  await transaction(shop, async () => {
    await orders.addToCart(shop, asha, offer.id, 1);
    await orders.placeOrder(shop, asha, address, 'card', 'tok_sim_visa_ok');
  });
  return await one(shop, `SELECT sh.id, o.user_id AS customer, se.user_id AS seller_user
                          FROM shipments sh JOIN orders o ON o.id = sh.order_id
                          JOIN warehouses w ON w.id = sh.warehouse_id LEFT JOIN sellers se ON se.id = w.seller_id
                          WHERE sh.status NOT IN ('delivered', 'cancelled') AND w.kind = 'seller_dispatch'
                          ORDER BY sh.id DESC LIMIT 1`);
}

// A seller-dispatched shipment, made three days late. Reuses one already in flight, and buys a
// fresh one only when the sample data has none.
async function aLateShipment() {
  let shipment = await one(shop, `SELECT sh.id, o.user_id AS customer, se.user_id AS seller_user
                                  FROM shipments sh JOIN orders o ON o.id = sh.order_id
                                  JOIN warehouses w ON w.id = sh.warehouse_id LEFT JOIN sellers se ON se.id = w.seller_id
                                  WHERE sh.status NOT IN ('delivered', 'cancelled') AND w.kind = 'seller_dispatch'
                                  ORDER BY sh.id LIMIT 1`);
  if (!shipment) shipment = await aSellerShipment();
  assert.ok(shipment, 'there is a seller-dispatched shipment to be late');
  await run(shop, 'UPDATE shipments SET eta = ? WHERE id = ?', threeDaysAgo, shipment.id);
  return shipment;
}

test('late_shipments finds only overdue, unfinished shipments, with days late', async () => {
  const s = await aLateShipment();
  const rows = await tool('late_shipments').run(shop, { today: TODAY }, {});
  const target = rows.find((r) => r.shipment_id === s.id);
  assert.ok(target, 'the shipment we made late is in the list');
  assert.equal(target.days_late, 3);
  assert.ok(rows.every((r) => r.days_late >= 1));
  assert.ok(rows.every((r) => !['delivered', 'cancelled'].includes(r.status)));
  // The list matches a direct count of overdue shipments, not a guess.
  assert.equal(rows.length, await scalar(shop, `SELECT COUNT(*) FROM shipments WHERE eta IS NOT NULL AND eta < ?
                                                AND status NOT IN ('delivered', 'cancelled')`, '2026-10-20'));
});

test('a seller nudge goes once a day and reaches the seller, not the customer', async () => {
  const s = await aLateShipment();
  const before = await scalar(shop, 'SELECT COUNT(*) FROM notifications WHERE user_id = ?', s.seller_user);
  const customerBefore = await scalar(shop, 'SELECT COUNT(*) FROM notifications WHERE user_id = ?', s.customer);
  const first = await tool('nudge_seller').run(shop, { agent: { user_id: 1 } },
    { shipment_id: s.id, message: 'This parcel is three days late: please dispatch it today.', reason: 'Late' });
  assert.deepEqual(first, { sent: true, to: 'seller' });
  assert.equal(await scalar(shop, 'SELECT COUNT(*) FROM notifications WHERE user_id = ?', s.seller_user), before + 1);
  assert.equal(await scalar(shop, 'SELECT COUNT(*) FROM notifications WHERE user_id = ?', s.customer), customerBefore);

  const second = await tool('nudge_seller').run(shop, { agent: { user_id: 1 } },
    { shipment_id: s.id, message: 'Again', reason: 'Late' });
  assert.equal(second.skipped, true);
  assert.equal(await scalar(shop, 'SELECT COUNT(*) FROM notifications WHERE user_id = ?', s.seller_user), before + 1);
});

test('a customer warning goes once a day, and only to the customer', async () => {
  const s = await aLateShipment();
  const before = await scalar(shop, 'SELECT COUNT(*) FROM notifications WHERE user_id = ?', s.customer);
  const first = await tool('warn_customer').run(shop, {}, {
    shipment_id: s.id, message: 'Your parcel is running three days late. We are sorry and we are chasing it.', reason: 'Late',
  });
  assert.deepEqual(first, { sent: true, to: 'customer' });
  assert.equal(await scalar(shop, 'SELECT COUNT(*) FROM notifications WHERE user_id = ?', s.customer), before + 1);
  const second = await tool('warn_customer').run(shop, {}, { shipment_id: s.id, message: 'Again', reason: 'Late' });
  assert.equal(second.skipped, true);
});

// ---------------------------------------------------------------- the Daily Brief's tool

test('the brief’s numbers are the database’s numbers', async () => {
  const numbers = await tool('get_daily_numbers').run(shop, {}, {});
  assert.equal(numbers.day, indiaDate());
  assert.equal(numbers.orders_today, await scalar(shop,
    'SELECT COUNT(*) FROM orders WHERE created_at >= ? AND created_at < ?',
    `${numbers.day}T00:00:00+05:30`, `${addDays(numbers.day, 1)}T00:00:00+05:30`));
  // The straightforward checks: every number is a number, and the ones with a direct SQL
  // equivalent match it.
  for (const [k, v] of Object.entries(numbers)) {
    if (k !== 'day') assert.equal(typeof v, 'number', k);
  }
  assert.equal(numbers.open_tickets, await scalar(shop, "SELECT COUNT(*) FROM support_tickets WHERE status = 'open'"));
  assert.equal(numbers.approvals_waiting, await scalar(shop, "SELECT COUNT(*) FROM approvals WHERE status = 'pending'"));
  assert.equal(numbers.submissions_waiting, await scalar(shop, "SELECT COUNT(*) FROM submissions WHERE status = 'pending'"));
  assert.equal(numbers.late_shipments, await scalar(shop,
    "SELECT COUNT(*) FROM shipments WHERE eta IS NOT NULL AND eta < ? AND status NOT IN ('delivered', 'cancelled')", numbers.day));
});

// ---------------------------------------------------------------- the agents end to end

// The scripted stand-in for the model, as the Phase 4 runtime tests use it.
function scripted(...steps) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(structuredClone(params));
        const step = steps[calls.length - 1];
        if (!step) throw new Error(`The script has no step ${calls.length}.`);
        return await step(params);
      },
    },
  };
}
const usage = { input_tokens: 900, output_tokens: 120 };
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage });
const toolUse = (name, input, id = 'tu_1') => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage });
const quiet = { sleep: async () => {} };

async function aHeldSubmission(note) {
  const seller = await one(shop, `SELECT s.id FROM sellers s JOIN users u ON u.id = s.user_id
                                 WHERE u.email = 'techbazaar.seller@example.com'`);
  return await transaction(shop, () => listings.submit(shop, seller.id, {
    title: `Kestrel K20 5G Smartphone (8GB RAM, 256GB) ${note}`, brand: 'Kestrel', category: 'Phones',
    description: 'A mid-range 5G phone with a 64MP camera, a 120Hz display and a 5500 mAh battery.',
    specs: { Display: '6.7-inch AMOLED' }, images: ['https://example.com/k20.jpg'], price: '21999', mrp: '24999',
    quantity: 10, handling_days: 1, fulfilment: 'seller', ships_to: ['ALL'],
  }));
}

test('in shadow mode the verdict is stored beside the person’s, and nothing goes live', async () => {
  await updateAgent(shop, 'listing_review', { enabled: true, autonomy_level: 1 });
  const sub = await aHeldSubmission('(shadow)');
  assert.equal(sub.status, 'pending');
  const client = scripted(
    () => toolUse('get_submission', { submission_id: sub.id }),
    () => say(JSON.stringify({ decision: 'approve', reasons: ['Details and price look right.'], confidence: 0.9, policy_refs: [] })),
  );
  const out = await reviewListing(shop, sub.id, { client, ...quiet });
  assert.equal(out.status, 'done');
  assert.deepEqual(out.decision.decision, 'approve');

  const after = await one(shop, 'SELECT status, agent_decision, agent_confidence, agent_run_id FROM submissions WHERE id = ?', sub.id);
  assert.equal(after.status, 'pending'); // shadow: the person still decides
  assert.equal(after.agent_decision.decision, 'approve');
  assert.equal(after.agent_confidence, 0.9);
  assert.ok(after.agent_run_id);

  // A retried job must not review the same submission twice.
  const runsBefore = await scalar(shop, "SELECT COUNT(*) FROM agent_runs WHERE agent_id = 'listing_review'");
  await reviewListing(shop, sub.id, { client: scripted(() => say('{}')), ...quiet });
  assert.equal(await scalar(shop, "SELECT COUNT(*) FROM agent_runs WHERE agent_id = 'listing_review'"), runsBefore);
});

test('the agreement score counts a match, then a mismatch, and ignores undecided cases', async () => {
  const ops = (await one(shop, "SELECT id FROM users WHERE email = 'ops@example.com'")).id;
  const judgedSub = await one(shop, `SELECT id FROM submissions WHERE agent_decision IS NOT NULL AND status = 'pending'
                                     ORDER BY id DESC LIMIT 1`);
  await transaction(shop, () => listings.decide(shop, judgedSub.id, true, 'Agreed with the agent.', ops));
  assert.deepEqual(await agreement(shop, 'listing_review'), { judged: 1, agreed: 1, rate: 1 });

  // A second case the agent gets wrong: it says approve, the person rejects.
  const sub = await aHeldSubmission('(disagree)');
  const client = scripted(() => say(JSON.stringify({ decision: 'approve', reasons: ['Looks fine.'], confidence: 0.6, policy_refs: [] })));
  await reviewListing(shop, sub.id, { client, ...quiet });
  await transaction(shop, () => listings.decide(shop, sub.id, false, 'Restricted term found.', ops));
  assert.deepEqual(await agreement(shop, 'listing_review'), { judged: 2, agreed: 1, rate: 0.5 });

  // A third the agent escalates: asking for a person is not agreeing with one.
  const third = await aHeldSubmission('(escalate)');
  const escalate = scripted(() => say(JSON.stringify({ decision: 'escalate', reasons: ['Unclear'], confidence: 0.2, policy_refs: [] })));
  await reviewListing(shop, third.id, { client: escalate, ...quiet });
  await transaction(shop, () => listings.decide(shop, third.id, true, 'Approved after a look.', ops));
  assert.deepEqual(await agreement(shop, 'listing_review'), { judged: 3, agreed: 1, rate: 0.333 });
});

test('Fulfilment Watch raises one task per shipment twice as late, once a day', async () => {
  await updateAgent(shop, 'fulfilment_watch', { enabled: false }); // the task never depends on the model
  const s = await aLateShipment();
  const today = indiaDate();
  await run(shop, 'UPDATE shipments SET eta = ? WHERE id = ?', addDays(today, -2), s.id);
  await watchFulfilment(shop, quiet);
  const mine = await all(shop, "SELECT * FROM ops_tasks WHERE dedupe_key = ?", `late:${s.id}:${today}`);
  assert.equal(mine.length, 1);
  assert.match(mine[0].body, /2 days past/);

  await watchFulfilment(shop, quiet); // the same day again changes nothing
  assert.equal((await all(shop, "SELECT * FROM ops_tasks WHERE dedupe_key = ?", `late:${s.id}:${today}`)).length, 1);

  // One day late is not "twice as late": no task for a different shipment that is only a day late.
  const other = await aSellerShipment();
  await run(shop, 'UPDATE shipments SET eta = ? WHERE id = ?', addDays(today, -1), other.id);
  await watchFulfilment(shop, quiet);
  assert.equal(await scalar(shop, 'SELECT COUNT(*) FROM ops_tasks WHERE subject = ?', `shipment:${other.id}`), 0);
});

test('the morning brief is a run whose summary Ops can show', async () => {
  await updateAgent(shop, 'daily_brief', { enabled: true });
  const client = scripted(
    () => toolUse('get_daily_numbers', {}),
    () => say('Two orders today. One shipment is three days late and needs a call. No approvals are waiting.'),
  );
  const out = await writeDailyBrief(shop, { client, ...quiet });
  assert.equal(out.status, 'done');
  assert.match(out.summary, /Two orders today/);
  assert.equal(out.agent_id, 'daily_brief');
  await updateAgent(shop, 'daily_brief', { enabled: false });
});

test('the tick queues Fulfilment Watch once an hour and the brief once a morning', async () => {
  const early = await jobs.tick(shop, { at: new Date('2030-01-02T01:00:00Z') }); // 06:30 IST
  assert.ok(early.enqueued.includes('agent:fulfilment_watch'));
  assert.ok(!early.enqueued.includes('agent:daily_brief'), 'no brief before 08:00 IST');

  const morning = await jobs.tick(shop, { at: new Date('2030-01-02T03:05:00Z') }); // 08:35 IST
  assert.ok(morning.enqueued.includes('agent:daily_brief'));
  const again = await jobs.tick(shop, { at: new Date('2030-01-02T03:20:00Z') }); // same hour, same day
  assert.ok(!again.enqueued.includes('agent:daily_brief'));
  assert.ok(!again.enqueued.includes('agent:fulfilment_watch'));
});

test('submission.created becomes exactly one Listing Review job', async () => {
  const sub = await aHeldSubmission('(job)');
  await jobs.dispatch(shop);
  const mine = await all(shop, "SELECT * FROM jobs WHERE kind = 'agent:listing_review' AND payload->>'entity_id' = ?", String(sub.id));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'queued');
});

// ---------------------------------------------------------------- the Ops routes

function opsClient() {
  const cookies = {};
  return async (method, path, body) => {
    const out = await handleApi(shop, { method, path, query: new URLSearchParams(), body, cookies });
    if (out.setCookie) {
      const [k, v] = out.setCookie.split(';')[0].split('=');
      if (v) cookies[k] = v; else delete cookies[k];
    }
    return out;
  };
}

test('Ops shows the agreement, the brief and the tasks, and only admins see them', async () => {
  const support = opsClient();
  // A staff member with only the support permission.
  await createUser(shop, 'support.phase5@example.com', 'Support (test)', 'a-long-password', 'ops', false, { permissions: ['support'] });
  assert.equal((await support('POST', '/api/ops/login', { email: 'support.phase5@example.com', password: 'a-long-password' })).status, 200);
  assert.equal((await support('GET', '/api/ops/tasks')).status, 403);

  const admin = opsClient();
  assert.equal((await admin('POST', '/api/ops/login', { email: 'ops@example.com', password: 'equidron-demo' })).status, 200);

  const agentsOut = await admin('GET', '/api/ops/agents');
  assert.equal(agentsOut.status, 200);
  const listingReview = agentsOut.payload.agents.find((a) => a.id === 'listing_review');
  assert.equal(listingReview.agreement.judged, 3);
  assert.equal(listingReview.agreement.rate, 0.333);
  assert.ok(agentsOut.payload.brief, 'the agents page carries the latest brief');
  assert.match(agentsOut.payload.brief.summary, /Two orders today/);

  const tasks = await admin('GET', '/api/ops/tasks');
  assert.ok(tasks.payload.tasks.length >= 1);
  const id = tasks.payload.tasks[0].id;
  assert.equal((await admin('POST', `/api/ops/tasks/${id}/done`)).status, 200);
  assert.equal((await admin('POST', `/api/ops/tasks/${id}/done`)).status, 409); // already closed
  assert.equal(await scalar(shop, "SELECT COUNT(*) FROM audit_log WHERE action = 'task.done' AND entity_id = ?", String(id)), 1);
});

// ---------------------------------------------------------------- the eval set

test('the listing eval set has 30 sound cases, and loading it twice adds nothing', async () => {
  const { SETS, seedEvalCases } = await import('../src/agents/evals.js');
  const cases = SETS.listing_review;
  assert.equal(cases.length, 30);
  const allowed = new Set(['approve', 'reject', 'escalate']);
  for (const c of cases) {
    assert.ok(c.name && c.fixture && c.expected, c.name);
    assert.ok(allowed.has(c.expected.decision), `${c.name}: ${c.expected.decision}`);
    assert.ok(Array.isArray(c.tags) && c.tags.length, `${c.name} has tags`);
  }
  // The mix the roadmap asks for: good, restricted, price traps, wrong category, injections.
  const tagged = (t) => cases.filter((c) => c.tags.includes(t)).length;
  assert.ok(tagged('good') >= 6 && tagged('restricted') >= 5 && tagged('price') >= 4);
  assert.ok(tagged('category') >= 3 && tagged('injection') >= 5);
  // An injection case must never be approvable, whatever else it expects.
  for (const c of cases.filter((x) => x.tags.includes('injection'))) assert.notEqual(c.expected.decision, 'approve');

  await seedEvalCases(shop, 'listing_review');
  await seedEvalCases(shop, 'listing_review');
  assert.equal(await scalar(shop, "SELECT COUNT(*) FROM eval_cases WHERE agent_id = 'listing_review'"), 30);
});

test('a run left “running” by a dead worker is taken over after twenty minutes, not immediately', async () => {
  await updateAgent(shop, 'listing_review', { enabled: true, autonomy_level: 1 });
  const sub = await aHeldSubmission('(stale run)');
  const insertRun = (minutesAgo) => run(shop, `INSERT INTO agent_runs (agent_id, trigger, subject, status, started_at)
      VALUES ('listing_review', 'event:submission.created', ?, 'running', now() - make_interval(mins => ?))`, String(sub.id), minutesAgo);
  const count = () => scalar(shop, "SELECT COUNT(*) FROM agent_runs WHERE agent_id = 'listing_review'");
  const fresh = await insertRun(1);

  const before = await count();
  await reviewListing(shop, sub.id, { client: scripted(() => say('{}')), ...quiet });
  assert.equal(await count(), before, 'a live run in progress is left alone');

  await run(shop, "UPDATE agent_runs SET started_at = now() - interval '30 minutes' WHERE id = ?", fresh);
  const client = scripted(() => say(JSON.stringify({ decision: 'reject', reasons: ['Replica'], confidence: 0.8, policy_refs: [] })));
  const out = await reviewListing(shop, sub.id, { client, ...quiet });
  assert.equal(out.status, 'done', 'the stale run is taken over');
  assert.equal((await one(shop, 'SELECT agent_decision FROM submissions WHERE id = ?', sub.id)).agent_decision.decision, 'reject');
});
