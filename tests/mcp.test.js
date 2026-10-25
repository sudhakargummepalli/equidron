// Phase 13: the MCP server. It fails closed without a token, exposes named tools only, and the one
// write tool is the approval inbox — the same decision a person makes in Ops.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { settings } from '../src/auth.js';
import { one, run } from '../src/db.js';
import { handle, TOOL_NAMES } from '../src/mcp.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
const TOKEN = 'test-mcp-token-please-change';
before(async () => { db = await openDatabase('memory'); delete process.env.MCP_TOKEN; });
after(async () => { await db?.close(); delete process.env.MCP_TOKEN; });

const call = (body, headers = {}) => handle(db, { headers, body });
const withToken = { authorization: `Bearer ${TOKEN}` };
const rpc = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });

test('without MCP_TOKEN configured, the server refuses everything', async () => {
  const out = await call(rpc('initialize'), withToken);
  assert.equal(out.status, 401);
  assert.match(out.payload.error.message, /not configured/);
});

test('a missing or wrong token is refused, and a right one is not', async () => {
  process.env.MCP_TOKEN = TOKEN;
  assert.equal((await call(rpc('initialize'), {})).status, 401);
  assert.equal((await call(rpc('initialize'), { authorization: 'Bearer nope' })).status, 401);
  const ok = await call(rpc('initialize'), withToken);
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.result.protocolVersion, '2024-11-05');
  assert.equal(ok.payload.result.serverInfo.name, 'equidron-ops');
});

test('initialize, ping and tools/list speak JSON-RPC', async () => {
  process.env.MCP_TOKEN = TOKEN;
  assert.deepEqual((await call(rpc('ping'), withToken)).payload.result, {});
  const list = await call(rpc('tools/list'), withToken);
  assert.equal(list.status, 200);
  const names = list.payload.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...TOOL_NAMES].sort());
  // Every tool has a description and a schema an MCP client can render.
  for (const t of list.payload.result.tools) {
    assert.ok(t.description.length > 10, t.name);
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('an unknown method or tool is a JSON-RPC error, not a crash', async () => {
  process.env.MCP_TOKEN = TOKEN;
  const bad = await call(rpc('nope/nothing'), withToken);
  assert.equal(bad.payload.error.code, -32601);
  const noTool = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'drop_tables' } }, withToken);
  assert.equal(noTool.payload.error.code, -32602);
});

test('list_approvals returns the pending inbox', async () => {
  process.env.MCP_TOKEN = TOKEN;
  const out = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_approvals', arguments: {} } }, withToken);
  assert.equal(out.status, 200);
  const payload = JSON.parse(out.payload.result.content[0].text);
  assert.ok(Array.isArray(payload));
});

test('deciding through MCP is the same decision as the Ops page, and runs once', async () => {
  process.env.MCP_TOKEN = TOKEN;
  // A pending approval, as a money tool at L2 would leave it. The run it belongs to is created here.
  const runId = await run(db, `INSERT INTO agent_runs (agent_id, trigger, status, subject) VALUES ('ops_helper', 'ops', 'waiting', 'mcp test')`);
  const approvalId = await run(db, `INSERT INTO approvals (run_id, agent_id, tool, risk, payload, idempotency_key, status, reason, amount_paise)
                                    VALUES (?, 'ops_helper', 'refund_return', 'money', ?, ?, 'pending', 'A refund above the limit.', 500000)`,
  runId, JSON.stringify({ return_id: 1, reason: 'test' }), `mcp-test-${Date.now()}`);
  assert.ok(approvalId);

  const out = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'decide_approval', arguments: { approval_id: approvalId, approve: false, note: 'Not this one.' } } }, withToken);
  const payload = JSON.parse(out.payload.result.content[0].text);
  assert.equal(payload.status, 'rejected');
  const row = await one(db, 'SELECT status, note FROM approvals WHERE id = ?', approvalId);
  assert.equal(row.status, 'rejected');
  assert.equal(row.note, 'Not this one.');
  // A second decision is refused, and reported as a tool error rather than a transport failure.
  const again = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'decide_approval', arguments: { approval_id: approvalId, approve: true } } }, withToken);
  assert.equal(again.payload.result.isError, true);
  assert.match(again.payload.result.content[0].text, /already rejected/);
});

test('the HTTP route is wired and also fails closed', async () => {
  delete process.env.MCP_TOKEN;
  const out = await handleApi(db, { method: 'POST', path: '/api/mcp', query: new URLSearchParams(),
    body: { jsonrpc: '2.0', id: 1, method: 'initialize' }, cookies: {}, headers: {} });
  assert.equal(out.status, 401);
  assert.match(out.payload.error.message, /not configured/);
});
