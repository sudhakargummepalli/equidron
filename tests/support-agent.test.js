// Phase 6, slice 2: the Support agent. A customer's ticket is answered from facts and policies,
// or escalated with a summary. A scripted model stands in, so nothing here calls a real one.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { getAgent, updateAgent } from '../src/agents/agents.js';
import { owns, tool } from '../src/agents/tools.js';
import { settings } from '../src/auth.js';
import { all, one, run } from '../src/db.js';
import { answerTicket } from '../src/job-kinds.js';
import * as orders from '../src/orders.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let asha;
let rahul;
let ashaOrder;
before(async () => {
  db = await openDatabase('memory');
  asha = await one(db, "SELECT id, name FROM users WHERE email = 'asha@example.com'");
  rahul = await one(db, "SELECT id, name FROM users WHERE email = 'rahul@example.com'");
  ashaOrder = await one(db, 'SELECT id FROM orders WHERE user_id = ? ORDER BY id LIMIT 1', asha.id);
});
after(async () => { await db?.close(); });

const usage = { input_tokens: 800, output_tokens: 200 };
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage });
const callTool = (name, input, id = 'tu_1') => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage });

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

async function on() {
  await updateAgent(db, 'support', { enabled: true, autonomy_level: 3 });
}
async function off() {
  await updateAgent(db, 'support', { enabled: false });
}

test('Support starts switched off, at L1, on the cheap model, and owns exactly its three tools', async () => {
  const agent = await getAgent(db, 'support');
  assert.equal(agent.enabled, false);
  assert.equal(agent.autonomy_level, 1);
  assert.equal(agent.model, 'claude-haiku-5-5');
  for (const name of ['get_ticket', 'reply_to_ticket', 'escalate_ticket']) {
    assert.ok(tool(name), `${name} is registered`);
    assert.ok(owns('support', name), `support owns ${name}`);
  }
  // A tool it must not have: taking money is a person's job in this slice.
  assert.ok(!owns('support', 'refund_return'));
});

test('a ticket is read, answered, and closed, with the facts from the customer’s own order', async () => {
  await on();
  const ticketId = await orders.createTicket(db, asha.id, ashaOrder.id, 'Where is my order?',
    'I ordered last week and the tracking has not moved. Where is it?');

  const client = scripted(
    () => callTool('get_ticket', { ticket_id: ticketId }),
    () => callTool('get_order', { order_id: ashaOrder.id }),
    () => callTool('reply_to_ticket', {
      ticket_id: ticketId, body: 'It is with the courier and arrives tomorrow.', close: true,
      reason: 'Answering the tracking question from the shipment facts.',
    }),
    () => say('Answered the customer from the shipment facts.'),
  );

  const out = await answerTicket(db, ticketId, { client });
  assert.equal(out.status, 'done');

  const messages = await all(db, 'SELECT author_role, body FROM support_messages WHERE ticket_id = ? ORDER BY id', ticketId);
  assert.equal(messages.length, 2, 'the customer message and one reply');
  assert.equal(messages[1].author_role, 'support');
  assert.match(messages[1].body, /arrives tomorrow/);
  assert.equal((await one(db, 'SELECT status FROM support_tickets WHERE id = ?', ticketId)).status, 'closed');

  // The run is traced, and the prompt carried the marketplace policies with a version.
  const trace = await one(db, 'SELECT * FROM agent_runs WHERE agent_id = ? AND subject = ?', 'support', `ticket:${ticketId}:msg:1`);
  assert.ok(trace, 'one run, keyed to the customer message');
  const system = client.calls[0].system;
  assert.match(system, /MARKETPLACE POLICIES/);
  assert.match(system, /refunds \(v1\)/);
  await off();
  await run(db, "UPDATE support_tickets SET status = 'open' WHERE id = ?", ticketId);
});

test('our own reply never starts another run: the loop guard holds', async () => {
  await on();
  const ticketId = await orders.createTicket(db, asha.id, null, 'Second question', 'Can I change my address?');
  const client = scripted(() => say('A person will help.'));
  await answerTicket(db, ticketId, { client });
  const runsBefore = await all(db, 'SELECT id FROM agent_runs WHERE agent_id = ?', 'support');

  // The support reply emitted ticket.message; the handler must see the author and stop.
  await orders.replyTicket(db, ticketId, 'support', 'Let me check that for you.', false);
  const again = scripted(() => say('should not run'));
  const out = await answerTicket(db, ticketId, { client: again });
  assert.equal(out, undefined, 'no run for a support-authored message');
  assert.equal(again.calls.length, 0);
  assert.equal((await all(db, 'SELECT id FROM agent_runs WHERE agent_id = ?', 'support')).length, runsBefore.length);
  await off();
});

test('a request outside the facts is escalated: one Ops task, one note to the customer', async () => {
  await on();
  const ticketId = await orders.createTicket(db, asha.id, ashaOrder.id, 'I want a refund to another account',
    'Please send the money to my friend instead of my card.');
  const client = scripted(
    () => callTool('get_ticket', { ticket_id: ticketId }),
    () => callTool('escalate_ticket', {
      ticket_id: ticketId,
      summary: 'Customer asks for a refund to a third party. Policy refunds to the original method; needs a person to decline kindly.',
      reason: 'Outside the refund policy, so a person decides.',
    }),
    () => say('Escalated.'),
  );
  await answerTicket(db, ticketId, { client });

  const task = await one(db, "SELECT * FROM ops_tasks WHERE kind = 'support_escalation' AND subject LIKE ?", `%${ticketId}%`);
  assert.ok(task, 'an Ops task holds the summary');
  assert.match(task.body, /third party/);
  const messages = await all(db, 'SELECT author_role, body FROM support_messages WHERE ticket_id = ? ORDER BY id', ticketId);
  assert.match(messages.at(-1).body, /passed this to a person/);

  // Running it again (a retry) must not open a second task.
  await run(db, "UPDATE support_tickets SET status = 'open' WHERE id = ?", ticketId);
  const retry = scripted(
    () => callTool('escalate_ticket', { ticket_id: ticketId, summary: 'Same again.', reason: 'Retry.' }),
    () => say('Escalated again.'),
  );
  await answerTicket(db, ticketId, { client: retry });
  const tasks = await all(db, "SELECT id FROM ops_tasks WHERE kind = 'support_escalation' AND subject LIKE ?", `%${ticketId}%`);
  assert.equal(tasks.length, 1, 'one task per ticket');
  await off();
});

test('a switched-off agent does nothing at all', async () => {
  await off();
  const ticketId = await orders.createTicket(db, asha.id, null, 'While the agent is off', 'Anyone there?');
  const client = scripted(() => say('must not run'));
  const out = await answerTicket(db, ticketId, { client });
  assert.equal(out, undefined);
  assert.equal(client.calls.length, 0);
});

test('the tools refuse another customer’s ticket, whatever the model asks for', async () => {
  const rahulTicket = await orders.createTicket(db, rahul.id, null, 'Rahul private', 'Something personal.');
  const getTicket = tool('get_ticket');
  await assert.rejects(() => getTicket.run(db, { customerId: asha.id }, { ticket_id: rahulTicket }), /another customer/);
  const reply = tool('reply_to_ticket');
  await assert.rejects(() => reply.run(db, { customerId: asha.id }, { ticket_id: rahulTicket, body: 'x', reason: 'y' }), /another customer/);
  // As Rahul himself, the same ticket is readable.
  const own = await getTicket.run(db, { customerId: rahul.id }, { ticket_id: rahulTicket });
  assert.equal(own.ticket_id, rahulTicket);
});
