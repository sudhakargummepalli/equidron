// Run one agent's eval set against the REAL model and record what happened.
//
//   node scripts/eval.js <agent>            a dry run: how many cases, which model, the likely cost
//   node scripts/eval.js <agent> --yes      actually calls the model (this spends credits)
//
// It costs money, so nothing runs without --yes, and the dry run always prints the estimate
// first. An eval case is a fixture (the situation, as JSON) and an expectation (the decision or
// the values that must appear in it). Decisions are graded by code; the quality of prose is not
// graded here - a person reads those.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { all, isServerUrl, run } from '../src/db.js';
import { getAgent, budgetLeft } from '../src/agents/agents.js';
import { costOf, knownModel } from '../src/agents/models.js';
import { seedEvalCases, taskFor } from '../src/agents/evals.js';
import { PROFILES } from '../src/agents/profiles.js';
import { runAgent } from '../src/agents/runtime.js';
import { loadEnv } from '../src/env.js';
import { openDatabase } from '../src/server.js';

loadEnv(); // ANTHROPIC_API_KEY may live in a local .env
const args = process.argv.slice(2);
const agentId = args.find((a) => !a.startsWith('--'));
const yes = args.includes('--yes');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

const OUTPUT_TOKENS = 600; // a decision, not an essay
const dollars = (usd) => `$${Number(usd).toFixed(4)}`;

function usage(message) {
  console.error(message);
  console.error('Usage: node scripts/eval.js <agent> [--yes] [--limit=N]');
  process.exit(2);
}

// What must be true of an answer: every key in `expected` appears in `actual` with that value.
function matches(actual, expected, path = '') {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (actual === null || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([k, v]) => matches(actual[k], v, `${path}${k}.`));
}

if (!agentId) usage('Say which agent to evaluate.');

// Same database as `node app.js`: DATABASE_URL when set, otherwise the local data/pg folder
// (created here, because PGlite wants its parent folder to exist). Results are kept there;
// point DATABASE_URL at a server to keep them somewhere durable.
const target = process.env.DATABASE_URL || path.join('data', 'pg');
if (!isServerUrl(target) && target !== 'memory') mkdirSync(path.resolve(target), { recursive: true });
const db = await openDatabase(target);
try {
  const agent = await getAgent(db, agentId);
  if (!agent) usage(`There is no agent called ${agentId} in this database.`);
  const profile = PROFILES[agentId];
  if (!profile) usage(`Agent ${agentId} has no profile in src/agents/profiles.js, so it cannot run.`);

  // The set that ships with the code is loaded on first use, so this works on a fresh database.
  await seedEvalCases(db, agentId);
  const cases = await all(db, 'SELECT * FROM eval_cases WHERE agent_id = ? ORDER BY id', agentId);
  if (!cases.length) {
    console.log(`No eval cases for ${agentId}: none ship with the code and none are in the database.`);
    process.exit(0);
  }
  const chosen = limit ? cases.slice(0, limit) : cases;

  // A rough estimate: the prompt and fixture in, a decision out, per case.
  const promptTokens = Math.ceil((profile.system.length + 200) / 4);
  const perCase = costOf(agent.model, { input_tokens: promptTokens, output_tokens: OUTPUT_TOKENS });
  const estimate = perCase * chosen.length;
  const left = await budgetLeft(db, agent);
  console.log(`${agent.name} (${agentId}) · model ${agent.model}${knownModel(agent.model) ? '' : ' (unpriced: cost will read 0)'}`);
  console.log(`${chosen.length} case(s) · about ${dollars(estimate)} of AI credit · ${dollars(left)} of today's ${dollars(agent.daily_budget_usd)} budget left`);

  if (!yes) {
    console.log('\nDry run: nothing was called. Re-run with --yes to spend the credits above.');
    for (const c of chosen) console.log(`  #${c.id} ${c.name}${c.tags?.length ? ` [${c.tags.join(', ')}]` : ''}`);
    process.exit(0);
  }

  if (estimate > left) {
    console.log('\nThat is more than the budget left for today. Raise the budget in Ops → Agents, or wait until tomorrow.');
    process.exit(1);
  }

  let passed = 0;
  let spent = 0;
  for (const c of chosen) {
    const task = taskFor(agentId, c.fixture);
    // "must_not" is a rule about the answer, not a field of it.
    const { must_not: mustNot = [], ...want } = c.expected || {};
    let actual = null;
    let ok = false;
    let caseCost = 0;
    try {
      const out = await runAgent(db, { agentId, task, trigger: 'eval', subject: `eval:${c.id}` }, {});
      actual = out.decision ?? out.reply ?? null;
      ok = matches(actual, want) && !mustNot.includes(actual?.decision);
      caseCost = Number(out.cost_usd) || 0;
      spent += caseCost;
    } catch (e) {
      actual = { error: e.message };
    }
    await run(db, 'INSERT INTO eval_results (case_id, model, passed, actual, cost_usd) VALUES (?,?,?,?,?)',
      c.id, agent.model, ok, JSON.stringify(actual ?? null), caseCost);
    if (ok) passed++;
    console.log(`${ok ? 'pass' : 'FAIL'}  #${c.id} ${c.name}`);
    if (!ok) console.log(`      expected ${JSON.stringify(c.expected)}\n      got      ${JSON.stringify(actual)}`);
  }
  console.log(`\n${passed}/${chosen.length} passed · spent about ${dollars(spent)}`);
  process.exit(passed === chosen.length ? 0 : 1);
} finally {
  await db.close();
}
