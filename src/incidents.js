// The incidents dashboard: one read-only answer to "is anything wrong right now?".
//
// It does not invent a new store of truth. Every number here is counted from the tables the
// rest of the app already writes (error_log, jobs, guardrail_events, agent_runs, approvals,
// shipments, ops_tasks, support_tickets), so the dashboard cannot drift from reality. Each
// check carries the Ops page where a person can act on it.
import { all, indiaDate, one, scalar } from './db.js';

// critical: something is broken and nobody has fixed it yet
// attention: something is waiting for a person, or a guardrail fired
// ok: nothing needs anyone right now
export const SEVERITY_ORDER = { ok: 0, attention: 1, critical: 2 };

const LABEL = {
  errors: 'Errors in the last 24 hours',
  dead_jobs: 'Dead jobs',
  failed_jobs: 'Jobs waiting to retry',
  failed_runs: 'Failed agent runs (24h)',
  guardrail_refusals: 'Guardrail refusals (24h)',
  guardrail_flags: 'Guardrail flags (24h)',
  late_shipments: 'Late shipments',
  open_tasks: 'Open Ops tasks',
  approvals_waiting: 'Approvals waiting',
  pending_submissions: 'Listings waiting for review',
  open_tickets: 'Open support tickets',
};

export async function snapshot(db, now = new Date()) {
  const n = (sql, ...params) => scalar(db, sql, ...params);

  const [errors, deadJobs, failedJobs, failedRuns, refusals, flags, late, tasks, approvals, submissions, tickets] = await Promise.all([
    n("SELECT COUNT(*) FROM error_log WHERE at > now() - interval '24 hours'"),
    n("SELECT COUNT(*) FROM jobs WHERE status = 'dead'"),
    n("SELECT COUNT(*) FROM jobs WHERE status = 'failed'"),
    n("SELECT COUNT(*) FROM agent_runs WHERE status = 'failed' AND started_at > now() - interval '24 hours'"),
    n("SELECT COUNT(*) FROM guardrail_events WHERE severity = 'refuse' AND at > now() - interval '24 hours'"),
    n("SELECT COUNT(*) FROM guardrail_events WHERE severity = 'flag' AND at > now() - interval '24 hours'"),
    n(`SELECT COUNT(*) FROM shipments WHERE eta IS NOT NULL AND eta < ? AND status NOT IN ('delivered', 'cancelled')`,
      indiaDate(now)),
    n("SELECT COUNT(*) FROM ops_tasks WHERE status = 'open'"),
    n("SELECT COUNT(*) FROM approvals WHERE status = 'pending'"),
    n("SELECT COUNT(*) FROM submissions WHERE status = 'pending'"),
    n("SELECT COUNT(*) FROM support_tickets WHERE status = 'open'"),
  ]);

  const paused = (await one(db, "SELECT value FROM settings WHERE key = 'agents.paused'"))?.value === true;

  // Each check: what it counts, how bad it is, and where to go about it.
  const checks = [
    { key: 'dead_jobs', count: Number(deadJobs), severity: 'critical', link: '#/system' },
    { key: 'failed_runs', count: Number(failedRuns), severity: 'critical', link: '#/runs' },
    { key: 'errors', count: Number(errors), severity: 'attention', link: '#/system' },
    { key: 'failed_jobs', count: Number(failedJobs), severity: 'attention', link: '#/system' },
    { key: 'guardrail_refusals', count: Number(refusals), severity: 'attention', link: '#/guardrails' },
    { key: 'guardrail_flags', count: Number(flags), severity: 'ok', link: '#/guardrails' },
    { key: 'late_shipments', count: Number(late), severity: 'attention', link: '#/tasks' },
    { key: 'open_tasks', count: Number(tasks), severity: 'attention', link: '#/tasks' },
    { key: 'approvals_waiting', count: Number(approvals), severity: 'attention', link: '#/approvals' },
    { key: 'pending_submissions', count: Number(submissions), severity: 'ok', link: '#/' },
    { key: 'open_tickets', count: Number(tickets), severity: 'ok', link: '#/support' },
  ].map((c) => ({ ...c, label: LABEL[c.key] }));

  // The dashboard is about things that should be zero. A check only matters when its count is
  // above zero; otherwise its severity is ignored.
  const active = checks.filter((c) => c.count > 0);
  const status = active.some((c) => c.severity === 'critical') ? 'critical'
    : (active.some((c) => c.severity === 'attention') || paused) ? 'attention'
      : 'ok';

  // The recent items behind the counts, so the page is useful without three more clicks.
  const recent = {
    errors: await all(db, 'SELECT id, source, message, request_id, at FROM error_log ORDER BY id DESC LIMIT 10'),
    dead_jobs: await all(db, "SELECT id, kind, attempts, last_error, finished_at FROM jobs WHERE status = 'dead' ORDER BY id DESC LIMIT 10"),
    guardrails: await all(db, 'SELECT id, role, area, rule, severity, detail, at FROM guardrail_events ORDER BY id DESC LIMIT 10'),
    failed_runs: await all(db, `SELECT id, agent_id, trigger, subject, error, started_at FROM agent_runs
                               WHERE status = 'failed' ORDER BY id DESC LIMIT 10`),
  };

  return {
    status,
    paused,
    at: now.toISOString(),
    totals: Object.fromEntries(checks.map((c) => [c.key, c.count])),
    checks,
    recent,
  };
}
