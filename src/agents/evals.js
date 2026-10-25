// The eval sets that ship with the code, and the one way to load them.
//
// An eval case is a fixture (the situation, as JSON) and an expectation (the decision, plus
// anything it must not do). Only the real model can be graded by these; the unit tests use the
// scripted stand-in, so they prove the machinery, not the judgement.
import { all, run } from '../db.js';
import LISTING_REVIEW from './evals/listing-review.json' with { type: 'json' };
import SUPPORT from './evals/support.json' with { type: 'json' };

export const SETS = {
  listing_review: LISTING_REVIEW,
  support: SUPPORT,
};

// Add the set to eval_cases, skipping names that are already there, so it can run on every
// start without piling up duplicates.
export async function seedEvalCases(db, agentId) {
  const cases = SETS[agentId] || [];
  const have = new Set((await all(db, 'SELECT name FROM eval_cases WHERE agent_id = ?', agentId)).map((r) => r.name));
  let added = 0;
  for (const c of cases) {
    if (have.has(c.name)) continue;
    await run(db, 'INSERT INTO eval_cases (agent_id, name, fixture, expected, tags) VALUES (?,?,?,?,?)',
      agentId, c.name, JSON.stringify(c.fixture), JSON.stringify(c.expected), c.tags);
    added++;
  }
  return added;
}

// What the agent is asked to do with one case. A listing judgment is answered from the facts
// in the case, without tools, so an eval never needs rows in the database.
export function taskFor(agentId, fixture) {
  if (fixture.task) return String(fixture.task);
  if (agentId === 'support') {
    return `A customer wrote to support:\n"${fixture.ticket}"\n\n`
      + 'Read the ticket, look up the facts, then reply to the customer or escalate to a person.';
  }
  if (agentId === 'listing_review') {
    return `Judge this submission. The facts:\n${JSON.stringify(fixture, null, 2)}\n\n`
      + 'Do not call any tools. Answer with the JSON decision only.';
  }
  return JSON.stringify(fixture);
}

// A support run is graded by what it did, not by its prose: the tool it reached for is the
// outcome. 'must_not_tools' is the hard half of the expectation - a case may pass on outcome and
// still fail by touching money it should have left alone.
export function gradeSupport(steps, expected = {}) {
  const tools = (steps || []).map((s) => s.tool).filter(Boolean);
  const outcome = tools.includes('refund_return') ? 'refund'
    : tools.includes('reject_return') ? 'reject'
      : tools.includes('escalate_ticket') ? 'escalate'
        : tools.includes('reply_to_ticket') ? 'reply' : 'none';
  const wanted = [].concat(expected.outcomes || []);
  const forbidden = [].concat(expected.must_not_tools || []);
  const broke = tools.filter((t) => forbidden.includes(t));
  const ok = (wanted.length ? wanted.includes(outcome) : outcome !== 'none') && broke.length === 0;
  return {
    ok, outcome, tools, broke,
    why: ok ? 'as expected'
      : broke.length ? `used a tool it must not: ${[...new Set(broke)].join(', ')}`
        : `outcome ${outcome}, expected ${wanted.join(' or ')}`,
  };
}
