// The 50 support cases and the way they are graded. No model is called here: the cases are checked
// as data, and the grader is exercised with made-up traces, so the machinery is proven for free.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { all, one } from '../src/db.js';
import { gradeSupport, seedEvalCases, SETS, taskFor } from '../src/agents/evals.js';
import { openDatabase } from '../src/server.js';

let db;
before(async () => { db = await openDatabase('memory'); });
after(async () => { await db?.close(); });

const cases = SETS.support;

test('there are exactly 50 cases, each with an id, a ticket and an expectation', () => {
  assert.equal(cases.length, 50);
  const names = new Set(cases.map((c) => c.name));
  assert.equal(names.size, 50, 'names are unique');
  for (const c of cases) {
    assert.ok(c.fixture?.ticket, `${c.name} has a ticket`);
    assert.ok((c.expected?.outcomes || []).length, `${c.name} says what outcome is acceptable`);
    assert.ok((c.expected?.must_not_tools || []).length, `${c.name} says what it must not do`);
  }
});

test('the categories the roadmap asks for are all represented', () => {
  const tags = new Set(cases.flatMap((c) => c.tags || []));
  for (const needed of ['where', 'damaged', 'late', 'scam', 'te', 'angry']) {
    assert.ok(tags.has(needed), `there is at least one ${needed} case`);
  }
  // Injection and the money rule have their own cases, because they are the ones a model gets wrong.
  assert.ok(tags.has('injection'));
  assert.ok(tags.has('money'));
  // A sixth of the set is in Telugu, which is the language the roadmap names.
  assert.ok(cases.filter((c) => (c.tags || []).includes('te')).length >= 6);
});

test('no case allows a refund: refunds are the Returns agent’s job, not Support’s', () => {
  for (const c of cases) {
    assert.ok(!(c.expected.outcomes || []).includes('refund'), `${c.name} must not expect a refund`);
    assert.ok((c.expected.must_not_tools || []).includes('refund_return'), `${c.name} forbids refund_return`);
  }
});

test('the task given to the agent is the customer’s own words', () => {
  const c = cases[0];
  assert.match(taskFor('support', c.fixture), new RegExp(c.fixture.ticket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 20)));
});

test('the grader reads the outcome from the tools the run used', () => {
  assert.equal(gradeSupport([{ tool: 'get_ticket' }, { tool: 'reply_to_ticket' }], { outcomes: ['reply'] }).ok, true);
  assert.equal(gradeSupport([{ tool: 'get_ticket' }, { tool: 'escalate_ticket' }], { outcomes: ['escalate'] }).outcome, 'escalate');
  assert.equal(gradeSupport([{ tool: 'get_ticket' }], { outcomes: ['reply'] }).outcome, 'none');
  assert.equal(gradeSupport([], { outcomes: ['reply'] }).ok, false);
});

test('a run that touches money fails even when the outcome is acceptable', () => {
  const graded = gradeSupport([{ tool: 'reply_to_ticket' }, { tool: 'refund_return' }],
    { outcomes: ['reply', 'refund'], must_not_tools: ['refund_return'] });
  assert.equal(graded.ok, false);
  assert.match(graded.why, /must not/);
  assert.deepEqual(graded.broke, ['refund_return']);
});

test('the cases can be seeded into eval_cases once, without piling up', async () => {
  const first = await seedEvalCases(db, 'support');
  assert.equal(first, 50);
  const again = await seedEvalCases(db, 'support');
  assert.equal(again, 0, 'a second run adds nothing');
  assert.equal(Number((await one(db, "SELECT COUNT(*) AS n FROM eval_cases WHERE agent_id = 'support'")).n), 50);
  const stored = await all(db, "SELECT name FROM eval_cases WHERE agent_id = 'support' ORDER BY name LIMIT 3");
  assert.equal(stored.length, 3);
});
