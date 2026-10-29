// Phase 14: the engineering agent's eyes and hands on GitHub.
//
// Authentication is a GitHub App, not a personal token: the app signs a short-lived JWT with its
// private key, exchanges it for an installation token (valid one hour), and uses that. Nothing here
// reads a password, and nothing is stored beyond the cached token in memory.
//
// Fail closed: with no app id, installation id or key, every call refuses. An engineering agent
// that cannot prove which app it is must not touch a repository.
import crypto from 'node:crypto';
import { badRequest } from './errors.js';

const API = 'https://api.github.com';
let cached = null; // { token, expiresAt }

export const owner = () => process.env.GITHUB_OWNER || 'sudhakargummepalli';
export const repo = () => process.env.GITHUB_REPO || 'equidron';
export const configured = () => Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_INSTALLATION_ID && keyPem());

// The key may be given base64-encoded (easiest to paste into an environment variable) or as a path.
function keyPem() {
  const inline = process.env.GITHUB_PRIVATE_KEY;
  if (inline) {
    const text = inline.includes('BEGIN') ? inline : Buffer.from(inline, 'base64').toString('utf8');
    return text.replace(/\\n/g, '\n');
  }
  return null;
}

// A GitHub App JWT: RS256, issued 60 seconds in the past to tolerate clock drift, ten minutes long
// (GitHub's maximum), with the app id as `iss`.
export function appJwt(nowSeconds = Math.floor(Date.now() / 1000)) {
  const pem = keyPem();
  const appId = process.env.GITHUB_APP_ID;
  if (!pem || !appId) throw badRequest('GitHub is not configured. Set GITHUB_APP_ID and GITHUB_PRIVATE_KEY.');
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 540, iss: Number(appId) || appId };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), crypto.createPrivateKey(pem)).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function installationToken() {
  if (!configured()) throw badRequest('GitHub is not configured. Set GITHUB_APP_ID, GITHUB_INSTALLATION_ID and GITHUB_PRIVATE_KEY.');
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - 120 > now) return cached.token;
  const res = await fetch(`${API}/app/installations/${process.env.GITHUB_INSTALLATION_ID}/access_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${appJwt()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw badRequest(`GitHub refused the installation token (${res.status}). ${body.message ?? ''}`.trim());
  cached = { token: body.token, expiresAt: Math.floor(new Date(body.expires_at).getTime() / 1000) || now + 3600 };
  return cached.token;
}

// One place that talks to GitHub. `path` starts with a slash and is relative to /repos/owner/repo
// unless `absolute` is set (the app-level endpoints, for instance).
export async function api(method, path, body = null, { absolute = false } = {}) {
  const token = await installationToken();
  const url = absolute ? `${API}${path}` : `${API}/repos/${owner()}/${repo()}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!res.ok) throw badRequest(`GitHub refused the request (${res.status}). ${payload.message ?? ''}`.trim());
  return payload;
}

// The reads the agent needs: open issues, a pull request's state, the checks on it, and recent CI runs.
export async function openIssues(limit = 20) {
  const rows = await api('GET', `/issues?state=open&per_page=${Math.min(50, Number(limit) || 20)}`);
  return rows.filter((i) => !i.pull_request).map((i) => ({
    number: i.number, title: i.title, labels: (i.labels || []).map((l) => l.name ?? l), created_at: i.created_at,
  }));
}

export async function pullRequest(number) {
  const pr = await api('GET', `/pulls/${Number(number)}`);
  const checks = await api('GET', `/commits/${pr.head.sha}/check-runs`);
  return {
    number: pr.number, title: pr.title, state: pr.state, draft: pr.draft, mergeable: pr.mergeable,
    head: pr.head.ref, base: pr.base.ref, changed_files: pr.changed_files,
    checks: (checks.check_runs || []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })),
  };
}

export async function failedRuns(limit = 5) {
  const runs = await api('GET', `/actions/runs?status=failure&per_page=${Math.min(20, Number(limit) || 5)}`);
  return (runs.workflow_runs || []).map((r) => ({
    id: r.id, name: r.name, branch: r.head_branch, conclusion: r.conclusion, url: r.html_url, created_at: r.created_at,
  }));
}

export async function commentOnIssue(number, text) {
  const body = String(text || '').trim();
  if (body.length < 5) throw badRequest('A comment needs text.');
  if (body.length > 2000) throw badRequest('Keep a comment under 2000 characters.');
  const out = await api('POST', `/issues/${Number(number)}/comments`, { body });
  return { id: out.id, url: out.html_url };
}

export const _resetCache = () => { cached = null; };
