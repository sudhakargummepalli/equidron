// The tool registry: the only doors an agent may open.
//
// A tool is a name, a description and a strict input schema the model is shown, plus a risk
// level and a `run()` that calls a service function people already use (orders.js and the
// rest). The agent never writes SQL and never gets its own copy of the business rules: it
// goes through the same transaction, row locks, audit rows and checks as a person clicking a
// button. The risk level is what the policy check (policy.js) reads.
//
//   read          looks at data and changes nothing
//   write         changes data that is easy to put right
//   money         moves money: refunds, payouts, payouts to a changed bank account
//   irreversible  can't be undone: deletions, bans, bulk messages
//
// ctx holds facts the model must not be able to forge, such as the customer in the case.
import { addDays, all, changes, indiaDate, one, run, scalar, transaction } from '../db.js';
import { actorUserId, audit } from '../audit.js';
import { badRequest } from '../errors.js';
import { emit } from '../events.js';
import { CATEGORIES, productDetail, search } from '../catalog.js';
import * as agents from './agents.js';
import * as jobs from '../jobs.js';
import * as listings from '../listings.js';
import * as notify from '../notify.js';
import * as orders from '../orders.js';
import * as proposals from '../proposals.js';
import * as risk from '../risk.js';

export const RISKS = ['read', 'write', 'money', 'irreversible'];

const TOOLS = new Map();

export function registerTool(tool) {
  for (const key of ['name', 'description', 'input_schema', 'risk', 'agents', 'run']) {
    if (!tool[key]) throw new Error(`A tool needs a ${key}.`);
  }
  if (!RISKS.includes(tool.risk)) throw new Error(`Unknown risk "${tool.risk}" for tool ${tool.name}.`);
  if (!Array.isArray(tool.agents) || !tool.agents.length) throw new Error(`Tool ${tool.name} must name the agents allowed to use it.`);
  if (tool.risk === 'money' && typeof tool.amount !== 'function') {
    throw new Error(`The money tool ${tool.name} needs amount(db, input): a limit can't be checked without it.`);
  }
  // Anything that changes the world must carry the agent's one-line reason, because that is
  // what an approver reads. A read has nothing to explain.
  if (tool.risk !== 'read' && !(tool.input_schema.required || []).includes('reason')) {
    throw new Error(`The ${tool.risk} tool ${tool.name} must require a "reason" so a person can see why.`);
  }
  if (TOOLS.has(tool.name)) throw new Error(`Tool ${tool.name} is registered twice.`);
  TOOLS.set(tool.name, { autoLimitPaise: null, ...tool });
  return TOOLS.get(tool.name);
}

export const tool = (name) => TOOLS.get(name) ?? null;
export const toolNames = () => [...TOOLS.keys()];
export const toolsFor = (agentId) => [...TOOLS.values()].filter((t) => t.agents.includes(agentId));
export const owns = (agentId, name) => Boolean(tool(name)?.agents.includes(agentId));

// The definitions sent to the model: only what this agent may use, and nothing about risk
// or limits (that is code's business, not the model's).
export const toolDefsFor = (agentId) => toolsFor(agentId).map(({ name, description, input_schema }) => ({ name, description, input_schema }));

// A strict check of one call against the tool's schema. The input comes from a model, so it
// is untrusted: unknown fields, missing fields and wrong types are refused here, before any
// service function sees them.
export function checkInput(t, input) {
  const schema = t.input_schema || {};
  const props = schema.properties || {};
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest(`${t.name} takes an object of fields.`);
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(props, key)) throw badRequest(`"${key}" is not a field of ${t.name}.`);
  }
  for (const key of schema.required || []) {
    if (input[key] === undefined || input[key] === null) throw badRequest(`${t.name} needs "${key}".`);
  }
  for (const [key, value] of Object.entries(input)) {
    const spec = props[key];
    if (spec.type === 'integer' && !Number.isInteger(value)) throw badRequest(`"${key}" must be a whole number.`);
    if (spec.type === 'number' && !Number.isFinite(value)) throw badRequest(`"${key}" must be a number.`);
    if (spec.type === 'boolean' && typeof value !== 'boolean') throw badRequest(`"${key}" must be true or false.`);
    if (spec.type === 'string') {
      if (typeof value !== 'string') throw badRequest(`"${key}" must be text.`);
      if (value.length > (spec.maxLength || 2000)) throw badRequest(`"${key}" is too long.`);
    }
  }
  return input;
}

// Run one tool call, inside ONE transaction, under an idempotency key.
//
// The key (run or job + tool + a hash of the input) is written in the same transaction as the
// change, so a retry after a crash finds the key and returns the first answer instead of
// acting twice. If the action failed and rolled back, the key went with it and a retry runs.
//
// Returns { replayed, result }. Throws AppError for a bad call or a rule the service refused.
export async function executeTool(db, agent, call, key, ctx = {}) {
  const t = tool(call.name);
  if (!t) throw badRequest(`Unknown tool ${call.name}.`);
  const input = checkInput(t, call.input || {});
  return await transaction(db, async () => {
    const fresh = await changes(db, `INSERT INTO idempotency_keys (user_id, key, route) VALUES (?,?,?)
                                     ON CONFLICT (user_id, key) DO NOTHING`, agent.user_id, key, `agent:${agent.id}:${t.name}`);
    if (!fresh) {
      const first = await one(db, 'SELECT response FROM idempotency_keys WHERE user_id = ? AND key = ?', agent.user_id, key);
      return { replayed: true, result: first?.response ?? null };
    }
    const result = await t.run(db, { ...ctx, agent, input }, input);
    await run(db, 'UPDATE idempotency_keys SET status = 200, response = ? WHERE user_id = ? AND key = ?',
      JSON.stringify(result ?? {}), agent.user_id, key);
    return { replayed: false, result };
  });
}

// ---------------------------------------------------------------- Phase 12: fraud and risk

registerTool({
  name: 'assess_order_risk',
  description: 'Score one order against the rule table and return the signals and one sentence. Read-only: it changes nothing.',
  risk: 'read',
  agents: ['fraud_risk'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: { order_id: { type: 'integer', description: 'The order number.' } },
    required: ['order_id'],
  },
  async run(db, ctx, input) {
    const result = await risk.assess(db, input.order_id);
    return { order_id: input.order_id, score: result.score, band: result.band, signals: result.signals, explanation: result.explanation };
  },
});

registerTool({
  name: 'hold_order',
  description: 'Hold an order for a person to look at. Reversible, and it never cancels the order.',
  risk: 'write',
  agents: ['fraud_risk'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      order_id: { type: 'integer', description: 'The order number.' },
      note: { type: 'string', minLength: 3, maxLength: 300, description: 'Why it is held, in a sentence a person can read.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why holding is right.' },
    },
    required: ['order_id', 'note', 'reason'],
  },
  async run(db, ctx, input) {
    const out = await risk.hold(db, input.order_id, { reason: input.note, by: ctx.agent?.user_id ?? null });
    return { ...out, reversible: 'A person can release it in Ops.' };
  },
});

registerTool({
  name: 'release_order_hold',
  description: 'Release a hold that is still active, with a note. The hold record stays in the history.',
  risk: 'write',
  agents: ['fraud_risk'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      order_id: { type: 'integer', description: 'The order number.' },
      note: { type: 'string', maxLength: 300, description: 'Why it can go ahead.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why releasing is right.' },
    },
    required: ['order_id', 'reason'],
  },
  async run(db, ctx, input) {
    const out = await risk.release(db, input.order_id, { by: ctx.agent?.user_id ?? null, note: input.note ?? null });
    return { ...out, note: 'The order was never cancelled by the hold.' };
  },
});

// ---------------------------------------------------------------- Phase 13: Ops Manager
//
// It may retry, pause and escalate. It may NOT unpause anything, raise a limit or change a
// permission: those tools simply do not exist, so the prompt is not the guard.

registerTool({
  name: 'ops_trouble',
  description: 'What is wrong right now: dead or retrying jobs, failed agent runs, paused agents. Read-only.',
  risk: 'read',
  agents: ['ops_manager'],
  input_schema: { type: 'object', additionalProperties: false, properties: {} },
  async run(db) {
    const jobs = await all(db, `SELECT id, kind, status, attempts, last_error, run_after FROM jobs
                                WHERE status IN ('dead', 'failed') OR (status = 'queued' AND attempts > 0)
                                ORDER BY id DESC LIMIT 20`);
    const runs = await all(db, `SELECT id, agent_id, status, error, started_at FROM agent_runs
                                WHERE status = 'failed' ORDER BY id DESC LIMIT 10`);
    const agentRows = await all(db, 'SELECT id, name, enabled, autonomy_level FROM agents ORDER BY id');
    return {
      jobs: jobs.map((j) => ({ job_id: Number(j.id), kind: j.kind, status: j.status, attempts: Number(j.attempts), error: j.last_error })),
      failed_runs: runs.map((r) => ({ run_id: Number(r.id), agent: r.agent_id, error: r.error })),
      agents: agentRows.map((a) => ({ agent_id: a.id, enabled: Boolean(a.enabled), level: Number(a.autonomy_level) })),
      paused_all: await agents.allPaused(db),
    };
  },
});

registerTool({
  name: 'retry_job',
  description: 'Put a dead or failed job back in the queue, once. It runs on the next tick.',
  risk: 'write',
  agents: ['ops_manager'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      job_id: { type: 'integer', description: 'The job id from ops_trouble.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why a retry is right.' },
    },
    required: ['job_id', 'reason'],
  },
  async run(db, ctx, input) {
    const ok = await jobs.retry(db, input.job_id);
    return { job_id: input.job_id, retried: ok, note: ok ? 'It runs on the next tick.' : 'That job is not dead or failed.' };
  },
});

registerTool({
  name: 'pause_agent',
  description: 'Switch one agent off when it is behaving badly. This cannot be undone by you: only a person can switch it back on.',
  risk: 'write',
  agents: ['ops_manager'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      agent_id: { type: 'string', maxLength: 40, description: 'The agent id from ops_trouble.' },
      note: { type: 'string', minLength: 3, maxLength: 300, description: 'Why it is being paused, for the person who reads it.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why pausing is right.' },
    },
    required: ['agent_id', 'note', 'reason'],
  },
  async run(db, ctx, input) {
    if (input.agent_id === 'ops_manager') throw badRequest('You cannot pause yourself; a person decides that.');
    const before = await agents.getAgent(db, input.agent_id);
    if (!before) throw badRequest('There is no such agent.');
    await agents.updateAgent(db, input.agent_id, { enabled: false });
    await audit(db, 'agent.pause', 'agent', input.agent_id, { enabled: Boolean(before.enabled) }, { enabled: false, note: input.note });
    return { agent_id: input.agent_id, enabled: false, note: 'A person must switch it back on in Ops → Agents.' };
  },
});

registerTool({
  name: 'escalate_to_person',
  description: 'Write an Ops task with a summary a person can act on, for anything you should not fix yourself.',
  risk: 'write',
  agents: ['ops_manager'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      subject: { type: 'string', minLength: 3, maxLength: 120, description: 'One line: what needs a person.' },
      body: { type: 'string', minLength: 3, maxLength: 800, description: 'What you saw, what you tried, what to do next.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why a person is needed.' },
    },
    required: ['subject', 'body', 'reason'],
  },
  async run(db, ctx, input) {
    const key = `ops_manager:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await run(db, `INSERT INTO ops_tasks (kind, subject, body, dedupe_key) VALUES ('ops_escalation', ?, ?, ?)`,
      input.subject, input.body, key);
    return { escalated: true, subject: input.subject };
  },
});

// ---------------------------------------------------------------- Phase 7: seller agents

registerTool({
  name: 'get_listing',
  description: 'One of the signed-in seller’s offers: price, stock, status, and the price band and automatic-pricing switch if set. Read-only.',
  risk: 'read',
  agents: ['pricing_copilot', 'catalog_builder'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: { offer_id: { type: 'integer', description: 'The offer id from the seller’s listings.' } },
    required: ['offer_id'],
  },
  async run(db, ctx, input) {
    if (!ctx.sellerId) throw badRequest('This tool works inside Seller Central.');
    const o = await one(db, `SELECT o.*, p.title, p.category FROM offers o JOIN products p ON p.id = o.product_id
                             WHERE o.id = ? AND o.seller_id = ?`, input.offer_id, ctx.sellerId);
    if (!o) throw badRequest('That listing belongs to another seller.');
    const stock = await all(db, 'SELECT COALESCE(SUM(on_hand - reserved), 0) AS available FROM inventory WHERE offer_id = ?', o.id);
    return {
      offer_id: Number(o.id), title: o.title, category: o.category, price_paise: Number(o.price_paise),
      floor_paise: o.price_floor_paise == null ? null : Number(o.price_floor_paise),
      ceiling_paise: o.price_ceiling_paise == null ? null : Number(o.price_ceiling_paise),
      auto_pricing: Boolean(o.auto_pricing), status: o.status,
      available: Number(stock[0]?.available ?? 0),
    };
  },
});

registerTool({
  name: 'set_listing_price',
  description: 'Change the price of one of the seller’s offers, inside the band the seller set. Outside the band it is refused, not clamped.',
  risk: 'write',
  agents: ['pricing_copilot'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      offer_id: { type: 'integer', description: 'The offer id.' },
      price_paise: { type: 'integer', minimum: 1, description: 'The new price in paise.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why this price now.' },
    },
    required: ['offer_id', 'price_paise', 'reason'],
  },
  async run(db, ctx, input) {
    if (!ctx.sellerId) throw badRequest('This tool works inside Seller Central.');
    const o = await one(db, 'SELECT * FROM offers WHERE id = ? AND seller_id = ?', input.offer_id, ctx.sellerId);
    if (!o) throw badRequest('That listing belongs to another seller.');
    if (o.price_floor_paise == null || o.price_ceiling_paise == null) {
      throw badRequest('This listing has no price band. The seller must set one before a price can move.');
    }
    if (!o.auto_pricing) throw badRequest('Automatic pricing is switched off for this listing.');
    const price = Number(input.price_paise);
    if (price < Number(o.price_floor_paise) || price > Number(o.price_ceiling_paise)) {
      // Refused, not clamped: a clamp would silently do something the seller never allowed.
      throw badRequest(`That price is outside the seller’s band (${orders.inr(o.price_floor_paise)}–${orders.inr(o.price_ceiling_paise)}).`);
    }
    const sub = await listings.submit(db, ctx.sellerId, {
      offer_id: o.id, price: price / 100, quantity: Number(ctx.qty ?? 0), ships_to: ['ALL'],
    });
    return { offer_id: Number(o.id), price_paise: price, submission_id: Number(sub.id), status: sub.status };
  },
});

registerTool({
  name: 'low_stock_listings',
  description: 'The signed-in seller’s offers at or below a stock level. Read-only.',
  risk: 'read',
  agents: ['pricing_copilot'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: { at_or_below: { type: 'integer', minimum: 0, maximum: 100, description: 'Stock level to report. Default 5.' } },
  },
  async run(db, ctx, input) {
    if (!ctx.sellerId) throw badRequest('This tool works inside Seller Central.');
    const level = Number(input.at_or_below ?? 5);
    const rows = await all(db, `SELECT o.id, p.title, COALESCE(SUM(i.on_hand - i.reserved), 0) AS available
                                FROM offers o JOIN products p ON p.id = o.product_id
                                LEFT JOIN inventory i ON i.offer_id = o.id
                                WHERE o.seller_id = ? GROUP BY o.id, p.title
                                HAVING COALESCE(SUM(i.on_hand - i.reserved), 0) <= ? ORDER BY available`, ctx.sellerId, level);
    return rows.map((r) => ({ offer_id: Number(r.id), title: r.title, available: Number(r.available) }));
  },
});

registerTool({
  name: 'draft_listing',
  description: 'Check a draft listing against the real rules and return it with every error found. Writes nothing: the seller reviews and submits it.',
  risk: 'read',
  agents: ['catalog_builder'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      title: { type: 'string', maxLength: 200 },
      brand: { type: 'string', maxLength: 60 },
      category: { type: 'string', maxLength: 40 },
      description: { type: 'string', maxLength: 5000 },
      price: { type: 'number', description: 'Price in rupees, as the seller would type it.' },
      quantity: { type: 'integer', minimum: 0, maximum: 100000 },
      specs: { type: 'object', description: 'Name/value pairs.' },
      images: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      ships_to: { type: 'array', items: { type: 'string' }, description: 'ALL, or a list of cities.' },
      fulfilment: { type: 'string', enum: ['equidron', 'seller'], description: 'Who ships it.' },
    },
  },
  async run(db, ctx, input) {
    if (!ctx.sellerId) throw badRequest('This tool works inside Seller Central.');
    const [payload, errors] = listings.validate(input, 'new_product');
    return {
      valid: Object.keys(errors).length === 0,
      draft: payload,
      errors,
      next: Object.keys(errors).length ? 'Fix these, then check again.' : 'The seller can submit this from Seller Central → Inventory.',
    };
  },
});

// ---------------------------------------------------------------- Phase 6: shopping concierge

registerTool({
  name: 'add_to_cart',
  description: 'Put one offer in the signed-in customer’s cart. Returns the cart’s new line count.',
  risk: 'write',
  agents: ['store_assistant'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      offer_id: { type: 'integer', description: 'The offer id from search_products or get_product.' },
      qty: { type: 'integer', minimum: 1, maximum: 10, description: 'How many. Default 1.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why this belongs in the cart.' },
    },
    required: ['offer_id', 'reason'],
  },
  async run(db, ctx, input) {
    if (!ctx.customerId) throw badRequest('The customer needs to be signed in to use a cart.');
    await orders.addToCart(db, ctx.customerId, input.offer_id, input.qty ?? 1);
    const cart = await orders.getCart(db, ctx.customerId);
    return { offer_id: input.offer_id, lines: cart.items.length, subtotal_paise: cart.estimate?.subtotal_paise ?? null };
  },
});

registerTool({
  name: 'update_cart',
  description: 'Change the quantity of an offer already in the cart. A quantity of 0 removes it.',
  risk: 'write',
  agents: ['store_assistant'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      offer_id: { type: 'integer', description: 'The offer id in the cart.' },
      qty: { type: 'integer', minimum: 0, maximum: 10, description: 'New quantity; 0 removes the line.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why the cart changes.' },
    },
    required: ['offer_id', 'qty', 'reason'],
  },
  async run(db, ctx, input) {
    if (!ctx.customerId) throw badRequest('The customer needs to be signed in to use a cart.');
    await orders.setCartQty(db, ctx.customerId, input.offer_id, input.qty);
    const cart = await orders.getCart(db, ctx.customerId);
    return { offer_id: input.offer_id, qty: input.qty, lines: cart.items.length };
  },
});

// "Propose" tools never change an order. They write a card the customer taps; the tap calls the
// same API a person would use, so the customer, not the agent, makes the change.
registerTool({
  name: 'propose_cancel',
  description: 'Offer to cancel an order: shows the customer a confirmation card. It does not cancel anything itself.',
  risk: 'write',
  agents: ['store_assistant'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      order_id: { type: 'integer', description: 'The order the customer wants to cancel.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why cancelling is what they asked for.' },
    },
    required: ['order_id', 'reason'],
  },
  async run(db, ctx, input) {
    if (!ctx.customerId) throw badRequest('The customer needs to be signed in to cancel an order.');
    const o = await orders.getOrder(db, input.order_id, ctx.customerId); // scoped: not found if it is not theirs
    if (o.status !== 'confirmed') throw badRequest(`Order #${o.id} is ${o.status}, so it cannot be cancelled.`);
    const proposalId = await proposals.create(db, ctx.customerId, 'cancel_order', { order_id: o.id, total_paise: o.total_paise });
    return { proposal_id: proposalId, needs_confirmation: true, summary: `Cancel order #${o.id} (${orders.inr(o.total_paise)})` };
  },
});

registerTool({
  name: 'propose_return',
  description: 'Offer to return an item: shows the customer a confirmation card. It does not open a return itself.',
  risk: 'write',
  agents: ['store_assistant'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      order_id: { type: 'integer', description: 'The order with the item.' },
      order_item_id: { type: 'integer', description: 'The order item id from get_my_order.' },
      qty: { type: 'integer', minimum: 1, maximum: 10, description: 'How many to return.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why the customer wants a return.' },
    },
    required: ['order_id', 'order_item_id', 'reason'],
  },
  async run(db, ctx, input) {
    if (!ctx.customerId) throw badRequest('The customer needs to be signed in to return an item.');
    const o = await orders.getOrder(db, input.order_id, ctx.customerId);
    // Items live under their shipment, and getOrder() has already attached the return rules.
    const item = o.shipments.flatMap((s) => s.items).find((i) => Number(i.id) === Number(input.order_item_id));
    if (!item) throw badRequest('That item is not in this order.');
    if (!item.returnable) throw badRequest(item.return_note || 'That item cannot be returned.');
    const qty = Number(input.qty ?? 1);
    if (qty > Number(item.returnable_qty ?? 0)) throw badRequest(`You can return at most ${item.returnable_qty} of this item.`);
    const proposalId = await proposals.create(db, ctx.customerId, 'return_item', {
      order_id: o.id, order_item_id: item.id, qty, title: item.title, reason: input.reason,
    });
    return { proposal_id: proposalId, needs_confirmation: true, summary: `Return ${item.title} from order #${o.id}` };
  },
});

// ---------------------------------------------------------------- the tools

registerTool({
  name: 'get_order',
  description: 'One order: status, payment, total, and each shipment with its stage and tracking number. Read-only.',
  risk: 'read',
  agents: ['ops_helper', 'support'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: { order_id: { type: 'integer', description: 'The order number.' } },
    required: ['order_id'],
  },
  // ctx.customerId comes from the case, never from the model, so a customer's assistant can
  // only read that customer's orders even if the model asks for someone else's.
  async run(db, ctx, input) {
    const o = await orders.getOrder(db, input.order_id, ctx.customerId ?? null);
    return {
      order_id: o.id, status: o.status, payment_status: o.payment_status, payment_method: o.payment_method,
      fulfilment: o.fulfilment_status, total_paise: o.total_paise, city: o.address?.city ?? null,
      shipments: o.shipments.map((s) => ({
        shipment_id: s.id, status: s.status, carrier: s.carrier, tracking_no: s.tracking_no, eta: s.eta,
      })),
    };
  },
});

registerTool({
  name: 'advance_shipment',
  description: 'Move one shipment to its next stage (packed, shipped, out for delivery, delivered). Refuses a delivered or cancelled shipment.',
  risk: 'write',
  agents: ['ops_helper'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      shipment_id: { type: 'integer', description: 'The shipment number from get_order.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why this shipment should move now.' },
    },
    required: ['shipment_id', 'reason'],
  },
  async run(db, ctx, input) {
    const s = await orders.advanceShipment(db, input.shipment_id, 'ops');
    return { shipment_id: s.id, status: s.status, carrier: s.carrier, tracking_no: s.tracking_no, next_stage: s.next_stage ?? null };
  },
});

registerTool({
  name: 'refund_return',
  description: 'Mark a returned item as received and refund it to the original payment method. Above the limit a person must approve it.',
  risk: 'money',
  agents: ['ops_helper', 'returns'],
  autoLimitPaise: 200_000, // Rs 2,000: above this, a person approves
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      return_id: { type: 'integer', description: 'The return number.' },
      reason: { type: 'string', maxLength: 200, description: 'Why the refund is due, in one sentence.' },
    },
    required: ['return_id', 'reason'],
  },
  async amount(db, input) {
    const row = await one(db, `SELECT oi.unit_price_paise * r.qty AS paise FROM returns r
                               JOIN order_items oi ON oi.id = r.order_item_id WHERE r.id = ?`, input.return_id);
    return row ? Number(row.paise) : null; // null: unknown, so a person decides
  },
  async run(db, ctx, input) {
    const refunded = await orders.receiveReturn(db, input.return_id, true, ctx.decidedBy ?? ctx.agent.user_id);
    return { return_id: input.return_id, refunded_paise: refunded };
  },
});

// ---------------------------------------------------------------- the store assistant
//
// Read-only lookups, the same shape the shop chat has always returned. They are tools like any
// other: the customer in the case comes from ctx (never from the model), and the policy check
// sees `risk: 'read'`.

const rupees = (paise) => (paise == null ? null : orders.inr(paise));

registerTool({
  name: 'search_products',
  description: 'Search the Equidron catalogue. Returns up to 8 matching products with the featured price, rating, stock and delivery estimate for the customer\'s city. Use it to find or compare products.',
  risk: 'read',
  agents: ['store_assistant'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'What to search for, e.g. "gaming laptop 32GB" or "kettle". Empty to browse a category.' },
      category: { type: 'string', enum: CATEGORIES, description: 'Optional category filter.' },
      max_price_rupees: { type: 'number', description: 'Optional maximum price in rupees.' },
      sort: { type: 'string', enum: ['relevance', 'price_asc', 'price_desc', 'rating'], description: 'Optional sort order. Default relevance.' },
    },
    required: ['query'],
  },
  async run(db, ctx, input) {
    const query = String(input.query ?? '').slice(0, 200);
    const category = CATEGORIES.includes(input.category) ? input.category : null;
    const sort = ['relevance', 'price_asc', 'price_desc', 'rating'].includes(input.sort) ? input.sort : 'relevance';
    let results = await search(db, query, category, sort, ctx.city);
    const max = Number(input.max_price_rupees);
    if (Number.isFinite(max) && max > 0) {
      results = results.filter((p) => (p.featured_offer ? p.featured_offer.price_paise : p.min_price_paise) <= max * 100);
    }
    return results.slice(0, 8).map((p) => {
      ctx.seen?.set(p.id, p.title);
      return {
        product_id: p.id, title: p.title, brand: p.brand, category: p.category,
        rating: p.rating, reviews: p.review_count,
        price: rupees(p.featured_offer ? p.featured_offer.price_paise : p.min_price_paise),
        mrp: rupees(p.featured_offer && p.featured_offer.mrp_paise),
        seller: p.featured_offer && p.featured_offer.seller_name,
        delivery_by: p.featured_offer && p.featured_offer.eta,
        offers: p.offer_count,
        availability: p.featured_offer ? 'in stock' : p.in_stock ? `not deliverable to ${ctx.city}` : 'out of stock',
        key_specs: Object.fromEntries(Object.entries(p.specs).slice(0, 5)),
      };
    });
  },
});

registerTool({
  name: 'get_product',
  description: 'Full details for one product: description, specifications, and every seller offer with price, condition, stock, delivery estimate and who ships it.',
  risk: 'read',
  agents: ['store_assistant'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: { product_id: { type: 'integer', description: 'Product id from search_products.' } },
    required: ['product_id'],
  },
  async run(db, ctx, input) {
    const p = await productDetail(db, Number(input.product_id), ctx.city);
    ctx.seen?.set(p.id, p.title);
    return {
      product_id: p.id, title: p.title, brand: p.brand, category: p.category, rating: p.rating, reviews: p.review_count,
      description: p.description, specs: p.specs,
      returns: p.return_window_days ? `Returnable within ${p.return_window_days} days of delivery` : 'Not returnable',
      offers: p.offers.map((o) => ({
        seller: o.seller_name, seller_rating: o.seller_rating, price: rupees(o.price_paise), mrp: rupees(o.mrp_paise),
        condition: o.condition, in_stock: o.available, deliverable_to_city: o.deliverable, delivery_by: o.eta,
        shipped_by: o.fulfilment_label, featured: o.is_featured,
      })),
    };
  },
});

registerTool({
  name: 'list_my_orders',
  description: "The signed-in customer's orders, newest first, with status, total and items.",
  risk: 'read',
  agents: ['store_assistant'],
  input_schema: { type: 'object', additionalProperties: false, properties: {} },
  async run(db, ctx) {
    if (!ctx.customerId) return { error: 'The customer is not signed in.' };
    return (await orders.listOrders(db, ctx.customerId)).slice(0, 20).map((o) => ({
      order_id: o.id, placed: o.created_at, status: o.status, payment: o.payment_status, fulfilment: o.fulfilment_status,
      total: rupees(o.total_paise), items: o.items.map((i) => `${i.title} × ${i.qty}`),
    }));
  },
});

registerTool({
  name: 'get_my_order',
  description: "One of the signed-in customer's orders: payment, each shipment's stage, tracking number and delivery estimate, and which items can still be returned.",
  risk: 'read',
  agents: ['store_assistant'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: { order_id: { type: 'integer' } },
    required: ['order_id'],
  },
  async run(db, ctx, input) {
    if (!ctx.customerId) return { error: 'The customer is not signed in.' };
    const o = await orders.getOrder(db, Number(input.order_id), ctx.customerId); // someone else's order: not found
    return {
      order_id: o.id, placed: o.created_at, status: o.status, payment_status: o.payment_status, fulfilment: o.fulfilment_status,
      total: rupees(o.total_paise), payment_method: o.payment_method, can_cancel: o.cancellable,
      deliver_to: o.address.city,
      shipments: o.shipments.map((s) => ({
        stage: s.status, from: s.warehouse_name, carrier: s.carrier, tracking: s.tracking_no, delivery_by: s.eta,
        items: s.items.map((i) => ({ title: i.title, qty: i.qty, price: rupees(i.unit_price_paise), returnable: i.returnable, return_note: i.return_note })),
      })),
      returns: o.returns.map((r) => ({ item: r.title, qty: r.qty, status: r.status, refund: rupees(r.refund_paise) })),
    };
  },
});

// ---------------------------------------------------------------- Listing Review (Phase 5)
//
// The agent reads one held submission and either recommends a decision (L1: recorded, a person
// still decides) or, at L3 on clean cases, makes it. `listings.decide()` is the same function
// the Ops button calls: it applies the change, writes the audit row and tells the seller.

registerTool({
  name: 'get_submission',
  description: 'One submission held for review: what the seller proposes, the live listing, other sellers\' offers for the same product, any restricted words, and the price against MRP.',
  risk: 'read',
  agents: ['listing_review'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: { submission_id: { type: 'integer', description: 'The submission number from the event.' } },
    required: ['submission_id'],
  },
  async run(db, ctx, input) {
    const s = await listings.getSubmission(db, input.submission_id);
    const p = s.payload || {};
    const siblings = s.product_id
      ? await all(db, `SELECT o.price_paise, o.condition, o.status, se.name AS seller FROM offers o
                       JOIN sellers se ON se.id = o.seller_id WHERE o.product_id = ? AND o.status = 'active'
                       ORDER BY o.price_paise`, s.product_id)
      : [];
    const text = `${p.title || ''} ${p.description || ''}`.toLowerCase();
    return {
      submission_id: s.id, seller: s.seller_name, kind: s.kind, status: s.status,
      proposed: {
        title: p.title, brand: p.brand, category: p.category, description: p.description, specs: p.specs,
        price: rupees(p.price_paise), mrp: rupees(p.mrp_paise), quantity: p.quantity, images: p.images,
        handling_days: p.handling_days, fulfilment: p.fulfilment, condition: p.condition,
      },
      live: s.live_product ? { title: s.live_product.title, category: s.live_product.category, description: s.live_product.description, specs: s.live_product.specs } : null,
      live_offer: s.live_offer,
      review_reasons: s.review_reasons,
      restricted_terms: listings.RESTRICTED_TERMS.filter((t) => text.includes(t)),
      price_vs_mrp_percent: p.price_paise && p.mrp_paise ? Math.round((p.price_paise / p.mrp_paise) * 1000) / 10 : null,
      other_offers: siblings.slice(0, 10).map((o) => ({ seller: o.seller, price: rupees(o.price_paise), condition: o.condition })),
    };
  },
});

registerTool({
  name: 'decide_submission',
  description: 'Approve or reject one held submission. Approving makes the change live immediately and tells the seller.',
  risk: 'write',
  agents: ['listing_review'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      submission_id: { type: 'integer' },
      approve: { type: 'boolean' },
      note: { type: 'string', maxLength: 300, description: 'The note the seller will read.' },
      reason: { type: 'string', maxLength: 200, description: 'Why, for the audit trail and any approver.' },
    },
    required: ['submission_id', 'approve', 'reason'],
  },
  async run(db, ctx, input) {
    const note = String(input.note || input.reason).slice(0, 300);
    const out = await listings.decide(db, input.submission_id, input.approve, note, ctx.decidedBy ?? ctx.agent.user_id);
    return { submission_id: input.submission_id, status: out.status, seller_notified: true };
  },
});

// ---------------------------------------------------------------- Fulfilment Watch (Phase 5)
//
// The job calls the agent once an hour with the count; the agent reads the facts with
// late_shipments and asks to message the seller, warn the customer, or nothing. At L1 those
// messages are recorded and not sent.

const DAY_MS = 86_400_000;
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

registerTool({
  name: 'late_shipments',
  description: 'Shipments past their delivery estimate that are not delivered or cancelled, oldest first, with how many days late they are and who to contact.',
  risk: 'read',
  agents: ['fulfilment_watch'],
  input_schema: { type: 'object', additionalProperties: false, properties: {} },
  async run(db, ctx) {
    const today = indiaDate(ctx.today ?? new Date());
    const rows = await all(db, `SELECT sh.id AS shipment_id, sh.status, sh.eta, o.id AS order_id,
                                       o.user_id AS customer_id, w.seller_id, se.user_id AS seller_user_id, se.name AS seller
                                FROM shipments sh JOIN orders o ON o.id = sh.order_id
                                JOIN warehouses w ON w.id = sh.warehouse_id
                                LEFT JOIN sellers se ON se.id = w.seller_id
                                WHERE sh.eta IS NOT NULL AND sh.status NOT IN ('delivered', 'cancelled')
                                  AND sh.eta < ? AND o.status NOT IN ('payment_failed')
                                ORDER BY sh.eta, sh.id`, today);
    return rows.slice(0, 25).map((r) => ({ ...r, days_late: daysBetween(r.eta, today) }));
  },
});

// Both messages are rate-limited to one per shipment per day, recorded as an event. The check
// runs inside the tool, so it holds even if a person approves the same message twice.
async function messagedToday(db, shipmentId, type) {
  return Boolean(await one(db, `SELECT 1 AS x FROM events WHERE type = ? AND payload->>'shipment_id' = ?
                                AND created_at > now() - interval '24 hours' LIMIT 1`, type, String(shipmentId)));
}

registerTool({
  name: 'nudge_seller',
  description: 'Send the seller an in-app nudge about one late shipment. One per shipment per day.',
  risk: 'write',
  agents: ['fulfilment_watch'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      shipment_id: { type: 'integer' },
      message: { type: 'string', maxLength: 300, description: 'What the seller should do, in one or two sentences.' },
      reason: { type: 'string', maxLength: 200 },
    },
    required: ['shipment_id', 'message', 'reason'],
  },
  async run(db, ctx, input) {
    const row = await one(db, `SELECT se.user_id AS seller_user, o.id AS order_id, sh.status FROM shipments sh
                               JOIN warehouses w ON w.id = sh.warehouse_id LEFT JOIN sellers se ON se.id = w.seller_id
                               JOIN orders o ON o.id = sh.order_id WHERE sh.id = ?`, input.shipment_id);
    if (!row) return { error: 'No such shipment.' };
    if (!row.seller_user) return { skipped: true, reason: 'This shipment is dispatched by Equidron, not a seller.' };
    if (await messagedToday(db, input.shipment_id, 'shipment.nudged')) {
      return { skipped: true, reason: 'The seller was already nudged in the last 24 hours.' };
    }
    await notify.notify(db, row.seller_user, input.message, `#/orders/${row.order_id}`);
    await emit(db, 'shipment.nudged', 'shipment', input.shipment_id, { shipment_id: input.shipment_id, to: 'seller' });
    return { sent: true, to: 'seller' };
  },
});

registerTool({
  name: 'warn_customer',
  description: 'Send the customer an early "running late" note about one late shipment. One per shipment per day.',
  risk: 'write',
  agents: ['fulfilment_watch'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      shipment_id: { type: 'integer' },
      message: { type: 'string', maxLength: 300, description: 'A short, honest note in plain words.' },
      reason: { type: 'string', maxLength: 200 },
    },
    required: ['shipment_id', 'message', 'reason'],
  },
  async run(db, ctx, input) {
    const row = await one(db, `SELECT o.user_id AS customer, o.id AS order_id FROM shipments sh
                               JOIN orders o ON o.id = sh.order_id WHERE sh.id = ?`, input.shipment_id);
    if (!row) return { error: 'No such shipment.' };
    if (await messagedToday(db, input.shipment_id, 'shipment.warned')) {
      return { skipped: true, reason: 'The customer was already told in the last 24 hours.' };
    }
    await notify.notify(db, row.customer, input.message, `#/orders/${row.order_id}`);
    await emit(db, 'shipment.warned', 'shipment', input.shipment_id, { shipment_id: input.shipment_id, to: 'customer' });
    return { sent: true, to: 'customer' };
  },
});

// ---------------------------------------------------------------- Daily Brief (Phase 5)
//
// One read tool, so the brief can only quote numbers that came out of SQL today.

registerTool({
  name: 'get_daily_numbers',
  description: 'Today\'s numbers for the morning brief: orders, cancellations, late shipments, open tickets, submissions waiting, approvals waiting, agent spend and failed runs.',
  risk: 'read',
  agents: ['daily_brief'],
  input_schema: { type: 'object', additionalProperties: false, properties: {} },
  async run(db, ctx) {
    const today = indiaDate(ctx.today ?? new Date());
    const from = `${today}T00:00:00+05:30`;
    const to = `${addDays(today, 1)}T00:00:00+05:30`;
    const n = (sql, ...params) => scalar(db, sql, ...params);
    return {
      day: today,
      orders_today: await n('SELECT COUNT(*) FROM orders WHERE created_at >= ? AND created_at < ?', from, to),
      cancelled_today: await n("SELECT COUNT(*) FROM orders WHERE status = 'cancelled' AND updated_at >= ? AND updated_at < ?", from, to),
      late_shipments: await n(`SELECT COUNT(*) FROM shipments WHERE eta IS NOT NULL AND eta < ?
                               AND status NOT IN ('delivered', 'cancelled')`, today),
      open_tickets: await n("SELECT COUNT(*) FROM support_tickets WHERE status = 'open'"),
      submissions_waiting: await n("SELECT COUNT(*) FROM submissions WHERE status = 'pending'"),
      approvals_waiting: await n("SELECT COUNT(*) FROM approvals WHERE status = 'pending'"),
      agent_spend_usd_today: Math.round((await n('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM agent_runs WHERE started_at >= ?', from)) * 1e5) / 1e5,
      failed_runs_today: await n("SELECT COUNT(*) FROM agent_runs WHERE status = 'failed' AND started_at >= ?", from),
      open_ops_tasks: await n("SELECT COUNT(*) FROM ops_tasks WHERE status = 'open'"),
    };
  },
});

// ---------------------------------------------------------------- Phase 6: customer support

registerTool({
  name: 'get_ticket',
  description: 'One support ticket with its messages, the customer name and the order it is about. Read-only.',
  risk: 'read',
  agents: ['support'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: { ticket_id: { type: 'integer', description: 'The ticket number.' } },
    required: ['ticket_id'],
  },
  async run(db, ctx, input) {
    const t = await one(db, `SELECT t.*, u.name AS customer_name FROM support_tickets t
                             JOIN users u ON u.id = t.user_id WHERE t.id = ?`, input.ticket_id);
    if (!t) throw badRequest('There is no such ticket.');
    // The customer in the case comes from the event, never from the model.
    if (ctx.customerId && t.user_id !== ctx.customerId) throw badRequest('That ticket belongs to another customer.');
    const messages = await all(db, 'SELECT author_role, body, at FROM support_messages WHERE ticket_id = ? ORDER BY id', t.id);
    return {
      ticket_id: Number(t.id), status: t.status, subject: t.subject, order_id: t.order_id ? Number(t.order_id) : null,
      customer_name: t.customer_name, messages,
    };
  },
});

registerTool({
  name: 'reply_to_ticket',
  description: 'Post a reply to the customer on their ticket. Set close when the question is settled.',
  risk: 'write',
  agents: ['support'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      ticket_id: { type: 'integer', description: 'The ticket number.' },
      body: { type: 'string', minLength: 1, maxLength: 4000, description: 'What the customer will read.' },
      close: { type: 'boolean', description: 'True when this reply settles the ticket.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why this reply is the right one.' },
    },
    required: ['ticket_id', 'body', 'reason'],
  },
  async run(db, ctx, input) {
    const t = await one(db, 'SELECT * FROM support_tickets WHERE id = ?', input.ticket_id);
    if (!t) throw badRequest('There is no such ticket.');
    if (ctx.customerId && t.user_id !== ctx.customerId) throw badRequest('That ticket belongs to another customer.');
    await orders.replyTicket(db, input.ticket_id, 'support', input.body, Boolean(input.close));
    return { ticket_id: Number(input.ticket_id), replied: true, closed: Boolean(input.close) };
  },
});

registerTool({
  name: 'escalate_ticket',
  description: 'Hand this ticket to a person: an Ops task with your summary, and a short note to the customer.',
  risk: 'write',
  agents: ['support'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      ticket_id: { type: 'integer', description: 'The ticket number.' },
      summary: { type: 'string', minLength: 1, maxLength: 800, description: 'One paragraph a person can act on: what the customer wants, what you found, why you stopped.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why this needs a person.' },
    },
    required: ['ticket_id', 'summary', 'reason'],
  },
  async run(db, ctx, input) {
    const t = await one(db, 'SELECT * FROM support_tickets WHERE id = ?', input.ticket_id);
    if (!t) throw badRequest('There is no such ticket.');
    if (ctx.customerId && t.user_id !== ctx.customerId) throw badRequest('That ticket belongs to another customer.');
    // One Ops task per ticket: a retried run must not open a second one.
    const fresh = await changes(db, `INSERT INTO ops_tasks (kind, subject, body, dedupe_key)
                                     VALUES ('support_escalation', ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
    `Ticket #${input.ticket_id}: ${t.subject}`, input.summary, `support:${input.ticket_id}:escalated`);
    if (fresh) {
      await orders.replyTicket(db, input.ticket_id, 'support',
        'Thank you for the details. I have passed this to a person on our team, who will reply here shortly.', false);
    }
    return { ticket_id: Number(input.ticket_id), escalated: true, already_escalated: !fresh };
  },
});

// ---------------------------------------------------------------- Phase 6: returns

registerTool({
  name: 'get_return',
  description: 'One return: the item, its order, the customer, the reason they gave and the return status. Read-only.',
  risk: 'read',
  agents: ['returns'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: { return_id: { type: 'integer', description: 'The return number.' } },
    required: ['return_id'],
  },
  async run(db, ctx, input) {
    const r = await one(db, `SELECT r.*, oi.title, oi.unit_price_paise, oi.qty AS item_qty, o.status AS order_status,
                                    o.payment_status, u.name AS customer_name, s.name AS seller_name,
                                    oi.unit_price_paise * r.qty AS refund_paise
                             FROM returns r JOIN order_items oi ON oi.id = r.order_item_id
                             JOIN orders o ON o.id = r.order_id JOIN users u ON u.id = r.user_id
                             JOIN sellers s ON s.id = oi.seller_id WHERE r.id = ?`, input.return_id);
    if (!r) throw badRequest('There is no such return.');
    return {
      return_id: Number(r.id), status: r.status, order_id: Number(r.order_id), title: r.title,
      qty: r.qty, reason: r.reason, refund_paise: Number(r.refund_paise), customer_name: r.customer_name,
      seller_name: r.seller_name, order_status: r.order_status, payment_status: r.payment_status,
    };
  },
});

registerTool({
  name: 'reject_return',
  description: 'Refuse a return with a short reason the customer will read. Use it only when the reason given does not match the policy.',
  risk: 'write',
  agents: ['returns'],
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      return_id: { type: 'integer', description: 'The return number.' },
      note: { type: 'string', minLength: 3, maxLength: 300, description: 'Why it is refused, in the customer’s words.' },
      reason: { type: 'string', maxLength: 200, description: 'One short sentence: why refusing is right here.' },
    },
    required: ['return_id', 'note', 'reason'],
  },
  async run(db, ctx, input) {
    await orders.rejectReturn(db, input.return_id, input.note, ctx.agent.user_id);
    return { return_id: Number(input.return_id), rejected: true };
  },
});
