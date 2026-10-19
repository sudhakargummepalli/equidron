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
import { changes, one, run, transaction } from '../db.js';
import { badRequest } from '../errors.js';
import { CATEGORIES, productDetail, search } from '../catalog.js';
import * as orders from '../orders.js';

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

// ---------------------------------------------------------------- the tools

registerTool({
  name: 'get_order',
  description: 'One order: status, payment, total, and each shipment with its stage and tracking number. Read-only.',
  risk: 'read',
  agents: ['ops_helper', 'store_assistant'],
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
  agents: ['ops_helper'],
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
