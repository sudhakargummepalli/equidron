// Agents as rows: one per agent, each with its own user account (role 'agent', which no
// sign-in page accepts), its switch, autonomy level, model and daily budget.
//
// The database holds the switches; src/agents/profiles.js holds the prompts, tool lists and
// output shapes, because a prompt is code and a budget is an operational setting.
import { createAgentUser } from '../auth.js';
import { all, indiaDate, one, run, scalar, transaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';

export const LEVELS = { 0: 'off', 1: 'shadow', 2: 'propose', 3: 'act within limits', 4: 'autonomous' };
export const PAUSED_KEY = 'agents.paused';

const ID_SHAPE = /^[a-z][a-z0-9_]{1,39}$/;

export const getAgent = (db, id) => one(db, 'SELECT * FROM agents WHERE id = ?', id);

export async function listAgents(db, today = new Date()) {
  const from = `${indiaDate(today)}T00:00:00+05:30`;
  return await all(db, `SELECT a.*, (SELECT COUNT(*) FROM agent_runs r WHERE r.agent_id = a.id) AS runs,
                               (SELECT MAX(r.started_at) FROM agent_runs r WHERE r.agent_id = a.id) AS last_run,
                               (SELECT COALESCE(SUM(r.cost_usd), 0) FROM agent_runs r
                                 WHERE r.agent_id = a.id AND r.started_at >= ?) AS spent_today_usd
                        FROM agents a ORDER BY a.id`, from);
}

// A new agent is off and at L1 (shadow) until a person turns it on and promotes it.
export async function createAgent(db, { id, name, model, effort = 'low', level = 1, enabled = false, maxSteps = 8, dailyBudgetUsd = 2 }) {
  if (!ID_SHAPE.test(String(id || ''))) throw badRequest('An agent id is lowercase letters, digits and _, starting with a letter.');
  if (!String(name || '').trim()) throw badRequest('An agent needs a name.');
  if (!String(model || '').trim()) throw badRequest('An agent needs a model.');
  return await transaction(db, async () => {
    if (await one(db, 'SELECT id FROM agents WHERE id = ?', id)) throw conflict(`There is already an agent called ${id}.`);
    const userId = await createAgentUser(db, id, name.trim());
    await run(db, `INSERT INTO agents (id, name, user_id, model, effort, autonomy_level, enabled, max_steps, daily_budget_usd)
                   VALUES (?,?,?,?,?,?,?,?,?)`,
    id, name.trim(), userId, model, effort, level, Boolean(enabled), maxSteps, dailyBudgetUsd);
    return await getAgent(db, id);
  });
}

// Change the switches a person controls. Everything else (prompt, tools) is code.
export async function updateAgent(db, id, patch = {}) {
  const before = await getAgent(db, id);
  if (!before) throw notFound('Agent');
  const next = { ...before };
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.autonomy_level !== undefined) {
    if (!Number.isInteger(patch.autonomy_level) || !Object.hasOwn(LEVELS, patch.autonomy_level)) {
      throw badRequest('The autonomy level is a whole number from 0 (off) to 4 (autonomous).');
    }
    next.autonomy_level = patch.autonomy_level;
  }
  if (patch.model !== undefined) {
    if (typeof patch.model !== 'string' || !patch.model.trim()) throw badRequest('Choose a model.');
    next.model = patch.model.trim();
  }
  if (patch.max_steps !== undefined) {
    if (!Number.isInteger(patch.max_steps) || patch.max_steps < 1 || patch.max_steps > 50) throw badRequest('Steps must be 1 to 50.');
    next.max_steps = patch.max_steps;
  }
  if (patch.daily_budget_usd !== undefined) {
    // An empty box on the page arrives as null; Number(null) is 0, which would silently switch
    // the agent off by budget, so refuse it instead.
    if (patch.daily_budget_usd === null || patch.daily_budget_usd === '') throw badRequest('The daily budget needs a number, for example 1 or 2.50.');
    const usd = Number(patch.daily_budget_usd);
    if (!Number.isFinite(usd) || usd < 0 || usd > 100) throw badRequest('The daily budget is between 0 and 100 US dollars.');
    next.daily_budget_usd = Math.round(usd * 100) / 100;
  }
  await run(db, `UPDATE agents SET enabled = ?, autonomy_level = ?, model = ?, max_steps = ?, daily_budget_usd = ? WHERE id = ?`,
    next.enabled, next.autonomy_level, next.model, next.max_steps, next.daily_budget_usd, id);
  return await getAgent(db, id);
}

// ---------------------------------------------------------------- the big red button

export async function allPaused(db) {
  const row = await one(db, 'SELECT value FROM settings WHERE key = ?', PAUSED_KEY);
  return row ? row.value === true : false;
}

export async function pauseAll(db, paused = true) {
  await run(db, `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, now())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, PAUSED_KEY, JSON.stringify(Boolean(paused)));
}

// ---------------------------------------------------------------- spending

// Today's spend in US dollars (an India day, like the assistant's daily limit), read from the
// runs themselves rather than a counter that can drift.
export async function spendToday(db, agentId = null, today = new Date()) {
  const from = `${indiaDate(today)}T00:00:00+05:30`;
  const row = agentId
    ? await one(db, 'SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM agent_runs WHERE agent_id = ? AND started_at >= ?', agentId, from)
    : await one(db, 'SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM agent_runs WHERE started_at >= ?', from);
  return Number(row.usd);
}

export async function budgetLeft(db, agent, today = new Date()) {
  return Math.max(0, Number(agent.daily_budget_usd) - await spendToday(db, agent.id, today));
}

// ---------------------------------------------------------------- the built-in agents

// Create any agent from profiles.js that is not in the database yet. Existing rows are left
// exactly as they are: a deploy must never quietly switch an agent on or raise its budget.
export async function ensureAgents(db, profiles) {
  const created = [];
  for (const [id, p] of Object.entries(profiles)) {
    if (await scalar(db, 'SELECT COUNT(*) FROM agents WHERE id = ?', id)) continue;
    await createAgent(db, {
      id, name: p.name, model: p.model, effort: p.effort ?? 'low', level: p.level ?? 1,
      enabled: p.enabled === true, maxSteps: p.maxSteps ?? 8, dailyBudgetUsd: p.dailyBudgetUsd ?? 2,
    });
    created.push(id);
  }
  return created;
}

export const countRuns = (db, agentId) => scalar(db, 'SELECT COUNT(*) FROM agent_runs WHERE agent_id = ?', agentId);
