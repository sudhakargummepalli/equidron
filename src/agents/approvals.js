// The approval inbox: an action the code would not let an agent take alone.
//
// The row stores exactly what will run if a person says yes — the tool and its input, not the
// model's memory of it. Approving executes that payload once: a guarded UPDATE decides who
// wins between two people clicking at the same time, and the tool's own idempotency key means
// even a repeated execution cannot act twice.
import { all, changes, one, run, transaction } from '../db.js';
import { audit } from '../audit.js';
import { conflict, notFound } from '../errors.js';
import { getAgent } from './agents.js';
import { explain } from './policy.js';
import { executeTool, tool } from './tools.js';

// Ask for a person. Safe to call twice with the same key (a retried job finds the first row).
export async function requestApproval(db, agent, runId, call, key, { amountPaise = null } = {}) {
  const t = tool(call.name);
  const why = String(call.input?.reason || '').trim();
  const reason = `${why ? `${why} ` : ''}${await explain(db, agent, call.name, call.input || {})}`.trim();
  return await transaction(db, async () => {
    const fresh = await changes(db, `INSERT INTO approvals (run_id, agent_id, tool, payload, risk, amount_paise, reason, idempotency_key)
                                     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (idempotency_key) DO NOTHING`,
      runId, agent.id, call.name, JSON.stringify(call.input || {}), t.risk, amountPaise, reason, key);
    if (fresh) await run(db, "UPDATE agent_runs SET status = 'waiting' WHERE id = ? AND status = 'running'", runId);
    return await one(db, 'SELECT * FROM approvals WHERE idempotency_key = ?', key);
  });
}

export const getApproval = (db, id) => one(db, 'SELECT * FROM approvals WHERE id = ?', id);

// Newest first. status null lists everything, which is what the Ops page asks for.
export async function listApprovals(db, status = 'pending', limit = 100) {
  return await all(db, `SELECT a.*, r.subject, r.trigger, r.summary AS run_summary
                        FROM approvals a LEFT JOIN agent_runs r ON r.id = a.run_id
                        WHERE (?::text IS NULL OR a.status = ?::text)
                        ORDER BY a.id DESC LIMIT ?`, status, status, Number(limit) || 100);
}

export const countPending = (db) => one(db, "SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").then((r) => Number(r.n));

// Approve or reject. Returns the approval row, and for an approval, what the tool returned.
export async function decideApproval(db, approvalId, { approve, byUserId, note = null }) {
  if (typeof approve !== 'boolean') throw conflict('Say whether to approve or reject.');
  return await transaction(db, async () => {
    const approval = await one(db, 'SELECT * FROM approvals WHERE id = ? FOR UPDATE', approvalId);
    if (!approval) throw notFound('Approval');
    if (approval.status !== 'pending') throw conflict(`This approval is already ${approval.status}.`);

    const status = approve ? 'approved' : 'rejected';
    // The guarded UPDATE is what makes "runs exactly once" true even with two people clicking.
    const won = await changes(db, `UPDATE approvals SET status = ?, decided_by = ?, decided_at = now(), note = ?
                                   WHERE id = ? AND status = 'pending'`, status, byUserId, note, approvalId);
    if (!won) throw conflict('Someone else decided this approval first.');
    await audit(db, `approval.${status}`, 'approval', approvalId, { status: 'pending' }, { status, tool: approval.tool, note });

    if (!approve) {
      if (approval.run_id) {
        await run(db, `UPDATE agent_runs SET status = 'done', summary = ?, finished_at = now() WHERE id = ? AND status = 'waiting'`,
          'A person rejected this action, so nothing ran.', approval.run_id);
      }
      return { ...(await getApproval(db, approvalId)), executed: false };
    }

    const agent = await getAgent(db, approval.agent_id);
    if (!agent) throw notFound('Agent');
    const done = await executeTool(db, agent, { name: approval.tool, input: approval.payload }, approval.idempotency_key,
      { decidedBy: byUserId });
    if (approval.run_id) {
      await run(db, `UPDATE agent_runs SET status = 'done', summary = ?, finished_at = now() WHERE id = ? AND status = 'waiting'`,
        `A person approved ${approval.tool}; it ran.`, approval.run_id);
    }
    return { ...(await getApproval(db, approvalId)), executed: true, result: done.result, replayed: done.replayed };
  });
}
