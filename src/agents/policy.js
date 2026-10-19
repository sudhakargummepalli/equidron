// The policy check. The code decides, not the prompt.
//
// Before any tool runs, decide() answers one of four things:
//
//   execute         run it now
//   shadow          record what the agent wanted to do and change nothing (L1: watch it first)
//   needs_approval  put it in the Ops approval inbox; a person decides
//   deny            never, and tell the agent why
//
// It fails closed: an unknown tool, an agent that is off, a paused system, a spent budget, a
// call above its limit or a hard gate all end in deny or approval, never in a guess. A model
// that has been sweet-talked by a product description still has to come through here.
import { allPaused, budgetLeft } from './agents.js';
import { tool } from './tools.js';

// Always a person, at every level: money leaving Equidron, permanent deletion, role and
// permission changes, bans, and messages to many people at once.
export const HARD_GATES = new Set(['run_payouts', 'delete_data', 'change_role', 'ban_user', 'send_bulk_message']);

export const DECISIONS = ['execute', 'shadow', 'needs_approval', 'deny'];

// agent: a row from agents (id, enabled, autonomy_level, daily_budget_usd, user_id).
// input: the tool call's input, already checked against the tool's schema.
export async function decide(db, agent, toolName, input = {}, today = new Date()) {
  const t = tool(toolName);
  if (!t) return 'deny';
  if (!t.agents.includes(agent.id)) return 'deny'; // not this agent's tool
  if (!agent.enabled || agent.autonomy_level === 0) return 'deny';
  if (await allPaused(db)) return 'deny'; // the big red button
  if ((await budgetLeft(db, agent, today)) <= 0) return 'deny'; // today's budget is spent

  if (t.risk === 'read') return 'execute'; // looking changes nothing, whoever asks
  if (agent.autonomy_level === 1) return 'shadow'; // L1: decide, record, do nothing

  if (HARD_GATES.has(toolName) || agent.autonomy_level === 2) return 'needs_approval';

  if (t.risk === 'money') {
    // An amount nobody can work out is never treated as small.
    const paise = await t.amount(db, input);
    if (!(Number.isFinite(paise) && paise <= t.autoLimitPaise)) return 'needs_approval';
  }
  if (t.risk === 'irreversible' && agent.autonomy_level < 4) return 'needs_approval';
  return 'execute';
}

// A sentence for the approval inbox, so a person sees why this is waiting.
export async function explain(db, agent, toolName, input = {}) {
  const t = tool(toolName);
  if (!t) return 'This tool does not exist.';
  if (HARD_GATES.has(toolName)) return `${t.name} is a hard gate: a person must decide, at every level.`;
  if (t.risk === 'money') {
    const paise = await t.amount(db, input);
    return Number.isFinite(paise)
      ? `${t.name} would move ₹${(paise / 100).toFixed(2)}, above the ₹${(t.autoLimitPaise / 100).toFixed(0)} limit.`
      : `${t.name} would move an amount that could not be worked out.`;
  }
  if (t.risk === 'irreversible') return `${t.name} cannot be undone, and this agent is below L4.`;
  return `${t.name} is a ${t.risk} action and this agent is at L2.`;
}
