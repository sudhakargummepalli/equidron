// The MCP server: a small JSON-RPC surface for an MCP client (Claude Desktop, an editor, a script)
// to read what Ops knows and to decide the approval inbox without opening the browser.
//
// Two rules carried over from the rest of the app:
//   - It fails closed. Without MCP_TOKEN configured, or with the wrong bearer token, every call is
//     refused; a token that can approve money must never be optional.
//   - It exposes named tools, not SQL. Each one calls the same service function the Ops page calls,
//     so a decision through MCP is indistinguishable from one made in the UI, audit row included.
import crypto from 'node:crypto';
import * as incidents from './incidents.js';
import { all } from './db.js';
import { decideApproval, listApprovals } from './agents/approvals.js';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_INFO = { name: 'equidron-ops', version: '1.0.0' };

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

// The tools an MCP client can see. Read tools come first; the one write tool is the approval inbox,
// which is exactly what a person already decides in Ops.
export const TOOLS = [
  {
    name: 'list_approvals',
    description: 'Approvals waiting for a person: what the agent wanted to do, why, and the amount if money is involved.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected'] } } },
    async run(db, input) {
      const rows = await listApprovals(db, input.status ?? 'pending', 50);
      return rows.map((a) => ({
        approval_id: Number(a.id), status: a.status, tool: a.tool, risk: a.risk,
        summary: a.summary ?? a.reason, amount_paise: a.amount_paise == null ? null : Number(a.amount_paise),
        agent: a.agent_id, subject: a.subject, requested_at: a.created_at,
      }));
    },
  },
  {
    name: 'decide_approval',
    description: 'Approve or reject one approval. Approving runs the stored action exactly once, as the Ops page does.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        approval_id: { type: 'integer' },
        approve: { type: 'boolean' },
        note: { type: 'string', maxLength: 300 },
      },
      required: ['approval_id', 'approve'],
    },
    async run(db, input, { actorUserId = null } = {}) {
      const out = await decideApproval(db, input.approval_id, { approve: input.approve, byUserId: actorUserId, note: input.note ?? null });
      return { approval_id: Number(input.approval_id), status: out.status ?? (input.approve ? 'approved' : 'rejected'), result: out.result ?? null };
    },
  },
  {
    name: 'get_incidents',
    description: 'The incidents snapshot: status, the checks that are not ok, and recent errors.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    async run(db) {
      const snap = await incidents.snapshot(db, new Date());
      return { status: snap.status, totals: snap.totals, checks: snap.checks.filter((c) => c.status !== 'ok') };
    },
  },
  {
    name: 'get_agent_runs',
    description: 'Recent agent runs with status, tokens and cost.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } },
    async run(db, input) {
      const rows = await all(db, `SELECT id, agent_id, trigger, status, subject, cost_usd, input_tokens, output_tokens, started_at
                                  FROM agent_runs ORDER BY id DESC LIMIT ?`, Number(input.limit ?? 20));
      return rows.map((r) => ({ run_id: Number(r.id), agent: r.agent_id, status: r.status, trigger: r.trigger,
        subject: r.subject, cost_usd: Number(r.cost_usd), tokens: Number(r.input_tokens) + Number(r.output_tokens), started_at: r.started_at }));
    },
  },
  {
    name: 'get_job_queue',
    description: 'Jobs that are dead, failed or retrying, with the last error.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    async run(db) {
      const rows = await all(db, `SELECT id, kind, status, attempts, last_error FROM jobs
                                  WHERE status IN ('dead', 'failed') OR (status = 'queued' AND attempts > 0)
                                  ORDER BY id DESC LIMIT 50`);
      return rows.map((j) => ({ job_id: Number(j.id), kind: j.kind, status: j.status, attempts: Number(j.attempts), error: j.last_error }));
    },
  },
];

const find = (name) => TOOLS.find((t) => t.name === name) ?? null;

// The bearer token, compared in constant time. No token configured means no service.
function authorised(headers) {
  const expected = process.env.MCP_TOKEN;
  if (!expected) return { ok: false, why: 'MCP is not configured on this deployment.' };
  const given = String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!given) return { ok: false, why: 'Send an Authorization: Bearer <MCP_TOKEN> header.' };
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const same = a.length === b.length && crypto.timingSafeEqual(a, b);
  return same ? { ok: true } : { ok: false, why: 'That token is not right.' };
}

// JSON-RPC over HTTP. One request in, one response out; notifications (no id) get no body.
export async function handle(db, { headers = {}, body } = {}) {
  const auth = authorised(headers);
  if (!auth.ok) {
    return { status: 401, payload: { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32001, message: auth.why } } };
  }
  if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return { status: 400, payload: { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'Not a JSON-RPC 2.0 request.' } } };
  }
  const { id = null, method, params = {} } = body;
  const reply = (result) => ({ status: 200, payload: { jsonrpc: '2.0', id, result } });
  const fail = (code, message, status = 200) => ({ status, payload: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === 'initialize') {
    return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'notifications/initialized') return { status: 202, payload: null };
  if (method === 'ping') return reply({});

  if (method === 'tools/list') {
    return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const t = find(name);
    if (!t) return fail(-32602, `There is no tool called "${name}".`);
    try {
      const result = await t.run(db, params.arguments ?? {}, { actorUserId: null });
      return reply(text(result));
    } catch (e) {
      // A tool error is reported as tool output, the way MCP expects, not as a transport failure.
      return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  return fail(-32601, `Unknown method "${method}".`);
}

// For the local server and the tests: the same handler, without the response wrapper.
export const TOOL_NAMES = TOOLS.map((t) => t.name);
