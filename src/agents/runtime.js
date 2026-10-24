// The runtime: one safe, visible loop that every agent runs through.
//
// It grew out of converse() in src/assistant.js, and adds what agents need that a chat
// assistant doesn't: a model, step, token and daily-spend limit per agent; retries on a busy
// or broken model; refusal handling; structured output for decisions; cost worked out from
// what the model reports; and a row for every model call and tool call, with personal data
// masked.
//
// What it deliberately does NOT do is decide anything. Every tool call goes through
// policy.decide() (code, not the prompt) and then through tools.executeTool() (one
// transaction, an idempotency key, the ordinary service function people use).
//
// Writing: runAgent keeps its own short writes (a run row, one step per call, the totals) and
// never wraps the whole run in one transaction, because a run can wait minutes on the model.
// Call it outside a request transaction: from a readOnly route, or from a job handler that
// does not open one.
import Anthropic from '@anthropic-ai/sdk';
import { actingAs } from '../audit.js';
import { one, run } from '../db.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';
import { mask } from '../mask.js';
import { policyText } from '../policies.js';
import { allPaused, budgetLeft, getAgent } from './agents.js';
import { requestApproval } from './approvals.js';
import { costOf, knownModel } from './models.js';
import { decide } from './policy.js';
import { PROFILES } from './profiles.js';
import { executeTool, tool, toolDefsFor } from './tools.js';

export const MAX_TOKENS = 4000; // per model call
export const MAX_TOKENS_PER_RUN = 60_000; // a run cannot talk its way past this
const MAX_TRIES = 3; // 429s and 5xx: try again, then give up on that call

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retryable = (e) => {
  const status = e?.status ?? e?.response?.status;
  return status === 429 || (Number.isFinite(status) && status >= 500);
};

let defaultClient = null;
export const isAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// Call the model, retrying a busy or broken one with growing pauses. Anything else (a 400, a
// bad key) is a real error and is not retried.
async function callModel(client, params, { sleep, tries = MAX_TRIES }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (e) {
      if (attempt >= tries || !retryable(e)) throw e;
      log('warn', 'agent model call will retry', { attempt, status: e?.status ?? null });
      await sleep(250 * 2 ** (attempt - 1));
    }
  }
}

const textOf = (response) => response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

// A decision-shaped reply (the agent's output schema) is parsed and checked in code; a reply
// that doesn't fit fails the run instead of being guessed at.
function readStructured(text, schema) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: 'The reply was not valid JSON.' };
  }
  if (value == null || typeof value !== 'object') return { error: 'The reply was not an object.' };
  const missing = (schema?.required || []).filter((k) => value[k] === undefined);
  if (missing.length) return { error: `The reply was missing ${missing.join(', ')}.` };
  return { value };
}

// A stable key for one tool call: the job (or run) plus the tool plus a hash of the input. A
// retry of the same call finds the key and does not act twice.
export function idempotencyKey({ jobId, runId, toolName, input }) {
  const text = JSON.stringify(input ?? {});
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
  return `${jobId ? `job:${jobId}` : `run:${runId}`}:${toolName}:${(hash >>> 0).toString(36)}`;
}

export async function startRun(db, agent, { trigger, subject = null, jobId = null }) {
  const id = await run(db, `INSERT INTO agent_runs (agent_id, job_id, trigger, subject, status) VALUES (?,?,?,?, 'running')`,
    agent.id, jobId, trigger, subject);
  return { id, agent, trigger, subject };
}

export async function stopRun(db, runId, status, { summary = null, error = null } = {}) {
  await run(db, `UPDATE agent_runs SET status = ?, summary = ?, error = ?, finished_at = now() WHERE id = ?`,
    status, summary == null ? null : mask(String(summary)).slice(0, 1000), error == null ? null : mask(String(error)).slice(0, 2000), runId);
  return await one(db, 'SELECT * FROM agent_runs WHERE id = ?', runId);
}

// One row per model call or tool call. The text is masked before it is stored: staff read the
// trace, and it is not a place for a customer's phone number.
async function recordStep(db, runId, step, { kind, tool: toolName = null, input = null, output = null, decision = null }) {
  await run(db, `INSERT INTO agent_steps (run_id, step, kind, tool, input, output, decision) VALUES (?,?,?,?,?,?,?)`,
    runId, step, kind, toolName,
    input == null ? null : JSON.stringify(mask(input)),
    output == null ? null : JSON.stringify(mask(output)),
    decision);
}

// Run one agent on one task. Returns the finished run row (with `reply`, and `decision` when
// the agent answers in a structured shape).
//
// options: { client, sleep, today, ctx } - a stand-in model and clock for tests, and the facts
// of the case (who is asking, their city, a map of things already looked up).
export async function runAgent(db, { agentId, task, messages: history, trigger = 'ops', subject = null, jobId = null }, options = {}) {
  const { client: givenClient = null, sleep = wait, today = new Date(), ctx = {} } = options;
  const agent = await getAgent(db, agentId);
  if (!agent) throw new AppError(404, `There is no agent called ${agentId}.`);
  const profile = PROFILES[agentId];
  if (!profile) throw new AppError(500, `Agent ${agentId} has no profile: it does not know what to do.`);
  if (!agent.enabled || agent.autonomy_level === 0) throw new AppError(409, `${agent.name} is switched off. Turn it on in Ops → Agents.`);
  if (await allPaused(db)) throw new AppError(409, 'All agents are paused. Nothing new can start until someone unpauses them.');
  if ((await budgetLeft(db, agent, today)) <= 0) throw new AppError(409, `${agent.name} has spent today's budget. It starts again tomorrow.`);
  if (!knownModel(agent.model)) log('warn', 'agent has an unpriced model, so its cost will read 0', { agent: agent.id, model: agent.model });

  let client = givenClient;
  if (!client) {
    if (!isAvailable()) throw new AppError(503, 'The agent runtime has no model credentials.');
    client = defaultClient ||= new Anthropic();
  }

  const { id: runId } = await startRun(db, agent, { trigger, subject, jobId });
  let step = 0;
  let tokens = 0;
  // Read once per run: the rules the agent must follow, with the version it followed. Cached on
  // the run so every round of the same conversation sees the same text.
  const policies = await policyText(db);

  // Update the run's totals after every model call, so the next budget check sees this spend
  // and a crash still leaves an honest trace.
  const recordModel = async (response) => {
    const usage = response.usage || {};
    const input = Number(usage.input_tokens) || 0;
    const output = Number(usage.output_tokens) || 0;
    const cost = costOf(agent.model, usage);
    tokens += input + output;
    await run(db, `UPDATE agent_runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ?
                   WHERE id = ?`, input, output, cost, runId);
    await recordStep(db, runId, ++step, {
      kind: 'model', output: { text: textOf(response), stop_reason: response.stop_reason, model: agent.model, tokens: input + output },
    });
  };

  const stop = async (status, summary, error = null) => {
    const row = await stopRun(db, runId, status, { summary, error });
    return { ...row, reply: summary };
  };

  // A chat agent brings its own conversation; every other agent gets one task line.
  const messages = history ? structuredClone(history) : [{ role: 'user', content: String(task) }];

  return await actingAs({ type: 'agent', id: `agent:${agent.id}`, userId: agent.user_id, runId }, async () => {
    for (let round = 0; round < agent.max_steps; round++) {
      // The kill switch and the budget are checked before every model call, and again before
      // every tool call below: a paused run stops at its next step.
      if (await allPaused(db)) return stop('stopped', 'All agents were paused during this run.');
      if ((await budgetLeft(db, agent, today)) <= 0) return stop('stopped', "The agent's daily budget was spent during this run.");
      if (tokens >= MAX_TOKENS_PER_RUN) return stop('stopped', 'This run reached its token limit.');

      let response;
      try {
        response = await callModel(client, {
          model: agent.model,
          max_tokens: MAX_TOKENS,
          system: [profile.system, profile.context ? profile.context(ctx) : '', policies].filter(Boolean).join('\n\n').trim(),
          output_config: { effort: agent.effort },
          tools: toolDefsFor(agent.id).length ? toolDefsFor(agent.id) : undefined,
          // The last round: answer with what has been looked up so far.
          tool_choice: { type: round < agent.max_steps - 1 ? 'auto' : 'none' },
          messages,
        }, { sleep });
      } catch (e) {
        const why = `The model call failed (${e?.status ?? 'no status'}).`;
        await stopRun(db, runId, 'failed', { error: `${why} ${e?.message ?? ''}` });
        throw e instanceof AppError ? e : new AppError(503, 'The agent could not reach the model. Please try again later.');
      }

      const text = textOf(response);
      await recordModel(response);
      if (response.stop_reason === 'refusal') return stop('done', `The model refused this request. ${text}`.trim());

      const calls = response.content.filter((b) => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || !calls.length) {
        if (profile.output) {
          const { value, error } = readStructured(text, profile.output);
          if (error) return stop('failed', 'The agent gave an unusable answer.', `${error} It said: ${text.slice(0, 500)}`);
          return { ...(await stop('done', text)), decision: value };
        }
        return stop('done', text || 'The agent finished without a reply.');
      }

      messages.push({ role: 'assistant', content: response.content });
      // A run that was paused while it was thinking stops here, before anything is done.
      if (await allPaused(db)) return stop('stopped', 'All agents were paused during this run.');
      const results = [];
      let waitingFor = null;
      for (const call of calls) {
        const decision = await decide(db, agent, call.name, call.input || {}, today);
        const key = idempotencyKey({ jobId, runId, toolName: call.name, input: call.input });
        let out;
        let isError = false;
        if (decision === 'deny') {
          isError = true;
          out = { error: 'This action is not allowed for this agent.' };
        } else if (decision === 'shadow') {
          out = { shadow: true, note: 'Recorded, not done: this agent is at L1 (shadow).' };
        } else if (decision === 'needs_approval') {
          const t = tool(call.name);
          const amount = t?.risk === 'money' ? await t.amount(db, call.input || {}) : null;
          const approval = await requestApproval(db, agent, runId, call, key, { amountPaise: amount });
          waitingFor = approval;
          out = { approval_id: approval.id, needs_approval: true, note: 'Waiting for a person in Ops → Approvals.' };
        } else {
          try {
            out = (await executeTool(db, agent, call, key, ctx)).result;
          } catch (e) {
            if (!(e instanceof AppError)) throw e;
            isError = true;
            out = { error: e.message };
          }
        }
        await recordStep(db, runId, ++step, { kind: 'tool', tool: call.name, input: call.input, output: out, decision });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out), is_error: isError });
      }
      if (waitingFor) {
        // The case waits here. A person decides in Ops; the approval runs from its stored
        // payload. (A follow-up turn for the agent comes with the first real agents, Phase 5.)
        return { ...(await stop('waiting', `Waiting for approval #${waitingFor.id}.`)), approval_id: waitingFor.id };
      }
      messages.push({ role: 'user', content: results });
    }
    return stop('stopped', 'The agent reached its step limit.');
  });
}
