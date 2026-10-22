// Store assistant: answers customer questions with Claude, using read-only store lookups as
// tools (product search, product details, the customer's own orders). It can't change
// anything: for orders, cancellations and returns it points the customer to the right page.
//
// It runs on the agent runtime (src/agents/runtime.js) like every other agent, so each chat is
// a run with its steps, tokens and cost visible in Ops. Its tools live in src/agents/tools.js
// and its prompt in src/agents/profiles.js.
//
// Credentials: on Netlify the AI Gateway injects ANTHROPIC_API_KEY and
// ANTHROPIC_BASE_URL, so the SDK needs no configuration. Locally, set
// ANTHROPIC_API_KEY to try it; without credentials the assistant reports it is unavailable.
import { mask } from './mask.js';
import Anthropic from '@anthropic-ai/sdk';
import { PROFILES, VOICE_REPLY, telugu } from './agents/profiles.js';
import { runAgent } from './agents/runtime.js';
import { indiaDate, one, transaction } from './db.js';
import { AppError, badRequest } from './errors.js';
import { guardChat } from './guardrails.js';

export { VOICE_REPLY, telugu };

export const MODEL = PROFILES.store_assistant.model;
const MAX_MESSAGES = 30;
const MAX_CHARS = 2000;
const MAX_TOOL_ROUNDS = 6;
const DEFAULT_DAILY_LIMIT = 30; // questions per customer per day; EQUIDRON_ASSISTANT_DAILY_LIMIT overrides it

// Only plain text turns come from the browser; tool calls happen inside one request.
function cleanHistory(messages) {
  if (!Array.isArray(messages) || !messages.length) throw badRequest('Ask a question.');
  const recent = messages.slice(-MAX_MESSAGES);
  const out = recent.map((m) => {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw badRequest('Invalid message.');
    const text = m.content.trim();
    if (!text) throw badRequest('Messages cannot be empty.');
    if (text.length > MAX_CHARS) throw badRequest(`Keep each message under ${MAX_CHARS} characters.`);
    return { role: m.role, content: text };
  });
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') throw badRequest('The last message must be your question.');
  return out;
}

export const isAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

export const dailyLimit = () => {
  const n = Number(process.env.EQUIDRON_ASSISTANT_DAILY_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
};

// Count one question against the customer's daily cap, in its own short transaction
// (the chat route runs outside the request transaction so it doesn't hold it during model calls).
// The upsert only bumps the count while it is under the limit, so concurrent questions can't overshoot.
async function countQuestion(db, userId, day, help) {
  const limit = dailyLimit();
  const row = await transaction(db, () => one(db,
    `INSERT INTO assistant_usage (user_id, day, questions) VALUES (?, ?, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET questions = assistant_usage.questions + 1
     WHERE assistant_usage.questions < ?
     RETURNING questions`, userId, day, limit));
  if (!row) {
    throw new AppError(429, `You've reached today's limit of ${limit} assistant questions. Please come back tomorrow, or ${help} for help now.`);
  }
}

// The customer assistant. ctx: { user, city, voice, language }; voice: the question was
// spoken; language: 'en' (default) or 'te' (Telugu). client: an Anthropic client (tests
// pass a stand-in). today: the date questions count against.
// Returns { reply, products: [{id, title}] } - products are ones the reply names.
export async function answer(db, ctx, rawMessages, options = {}) {
  const messages = cleanHistory(rawMessages);
  const today = options.today ?? new Date();
  // The guardrail runs before the daily count and before the model: a message that is abuse, an
  // attempt to rewrite the instructions, or a card number is refused here, and never sent.
  await guardChat(db, { role: 'customer', area: 'shop', user: ctx.user, text: messages.at(-1).content });
  if (ctx.user) await countQuestion(db, ctx.user.id, indiaDate(today), 'use Customer service'); // the limit resets at midnight in India
  const seen = new Map(); // the products the tools looked at, so the reply can link the ones it names

  let out;
  try {
    out = await runAgent(db, {
      agentId: 'store_assistant',
      messages,
      trigger: 'chat',
      subject: ctx.user ? `user:${ctx.user.id}` : null,
    }, { ...options, today, ctx: { ...ctx, customerId: ctx.user?.id ?? null, seen } });
  } catch (e) {
    if (e instanceof AppError && e.status === 503) {
      throw new AppError(503, 'The assistant is not available right now. Please use Customer service.');
    }
    throw e;
  }

  if (out.status !== 'done') {
    throw new AppError(503, out.status === 'stopped'
      ? 'The assistant took too long. Please ask a simpler question.'
      : 'The assistant is not available right now. Please try again later.');
  }
  if (String(out.summary || '').startsWith('The model refused')) {
    return { reply: "Sorry, I can't help with that. Please use Customer service.", products: [] };
  }
  const reply = String(out.reply || '').trim() || 'Sorry, I could not find an answer. Please try rephrasing, or use Customer service.';
  const products = [...seen].filter(([, title]) => reply.includes(title)).map(([id, title]) => ({ id, title }));
  return { reply, products };
}

let defaultClient = null;

// The chat loop the seller assistant still uses directly. profile: { system, context,
// tools, runTool(db, ctx, name, input, seen), help }. Tools record what they looked up in
// `seen` (id -> title); the reply returns the entries it names so the page can link them.
export async function converse(db, ctx, rawMessages, profile, { client = null, today = new Date() } = {}) {
  const messages = cleanHistory(rawMessages);
  if (!client) {
    if (!isAvailable()) throw new AppError(503, `The assistant is not available right now. Please ${profile.help}.`);
    client = defaultClient ||= new Anthropic();
  }
  if (ctx.user) await countQuestion(db, ctx.user.id, indiaDate(today), profile.help); // the limit resets at midnight in India
  const seen = new Map();

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let response;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 4000,
        system: `${profile.system}\n\n${profile.context}`,
        output_config: { effort: 'low' },
        tools: profile.tools,
        // Last round: answer with what has been looked up so far.
        tool_choice: { type: round < MAX_TOOL_ROUNDS ? 'auto' : 'none' },
        messages,
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new AppError(429, 'The assistant is busy. Please try again in a minute.');
      if (e instanceof Anthropic.APIError) {
        console.error('assistant API error', e.status, mask(e.message));
        throw new AppError(503, 'The assistant is not available right now. Please try again later.');
      }
      throw e;
    }

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (response.stop_reason === 'refusal') {
      return { reply: `Sorry, I can't help with that. Please ${profile.help}.`, products: [] };
    }
    const toolCalls = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !toolCalls.length) {
      const reply = text || `Sorry, I could not find an answer. Please try rephrasing, or ${profile.help}.`;
      const products = [...seen].filter(([, title]) => reply.includes(title)).map(([id, title]) => ({ id, title }));
      return { reply, products };
    }

    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const call of toolCalls) {
      let content;
      let isError = false;
      try {
        content = JSON.stringify(await profile.runTool(db, ctx, call.name, call.input || {}, seen));
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        content = JSON.stringify({ error: e.message });
        isError = true;
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content, is_error: isError });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new AppError(503, 'The assistant took too long. Please ask a simpler question.');
}
