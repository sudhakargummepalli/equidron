// JSON API for the three interfaces, independent of the HTTP layer so the same
// routes run in the local server (src/server.js) and the Netlify Function.
//
// API areas and the session role each one accepts:
//   /api/shop/...    customer   (cookie eq_shop,   Path=/api/shop)
//   /api/seller/...  seller     (cookie eq_seller, Path=/api/seller)
//   /api/ops/...     ops        (cookie eq_ops,    Path=/api/ops)
import * as assistant from './assistant.js';
import { ANONYMOUS, actingAs, audit, auditsWritten, listAudit, safeBody, setActor, userActor } from './audit.js';
import * as agents from './agents/agents.js';
import * as approvals from './agents/approvals.js';
import { runAgent } from './agents/runtime.js';
import * as auth from './auth.js';
import * as catalog from './catalog.js';
import { all, changes, one, run, scalar, transaction } from './db.js';
import { AppError } from './errors.js';
import { capBulk, counts as guardrailCounts, recent as recentGuardrails } from './guardrails.js';
import * as incidents from './incidents.js';
import * as analytics from './analytics.js';
import * as telegram from './telegram.js';
import * as listings from './listings.js';
import * as jobs from './jobs.js';
import { newRequestId, reportError, requestId, withRequestId } from './log.js';
import { mask } from './mask.js';
import { listOutbox } from './outbox.js';
import * as notify from './notify.js';
import * as orders from './orders.js';
import { answerSeller } from './seller-assistant.js';
import { PAYMENT_OPTIONS } from './payments.js';
import { loadStatement } from './statement.js';

export const AREAS = { shop: 'customer', seller: 'seller', ops: 'ops' };
const SAMPLE_NOTICE = 'Sample data: every seller, product, customer and order here is fictional. Payments are simulated.';
const ROUTES = [];

// The staff permission each part of Ops needs (see auth.PERMISSIONS). An Ops route
// that isn't listed needs admin, so a new route is closed until someone opens it.
const OPS_PERMISSIONS = [
  [/^\/(login|logout|logout-all|me|notifications|notifications\/read|overview|password\/forgot|password\/reset)$/, null],
  [/^\/2fa/, null],
  [/^\/submissions/, 'catalog'],
  [/^\/shipments/, 'logistics'],
  [/^\/(returns|support)/, 'support'],
  [/^\/settlement/, 'finance'],
];
const opsPermission = (pattern) => (OPS_PERMISSIONS.find(([re]) => re.test(pattern)) ?? [null, 'admin'])[1];

// readOnly: a non-GET route that writes nothing, so it runs outside a transaction
// (the assistant waits seconds on the model and must not hold the write lock).
// prepare(body): slow work done before the transaction; its result is ctx.prepared.
// Each write route also has an audit name, used when its service functions record nothing:
// POST /orders/(\d+)/cancel in shop is "shop.orders.cancel" on entity "orders".
function route(method, area, pattern, fn, isPublic = false, { readOnly = false, prepare = null } = {}) {
  const words = pattern.split('/').filter((s) => s && !s.startsWith('('));
  const action = [area, ...words].join('.') + (method === 'POST' ? '' : `.${method.toLowerCase()}`);
  const permission = area === 'ops' ? opsPermission(pattern) : null;
  ROUTES.push({ method, area, pattern: new RegExp(`^${pattern}$`), fn, isPublic, readOnly, prepare, action, entity: words[0] || area, permission });
}

class Reply {
  constructor(status, payload, cookie = null) {
    Object.assign(this, { status, payload, cookie });
  }
}

const int = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new AppError(400, 'Invalid request: expected a whole number.');
  return n;
};

// ---------------------------------------------------------------- shared auth routes

for (const area of Object.keys(AREAS)) {
  const role = AREAS[area];
  route('POST', area, '/login', async (c) => {
    let token;
    try {
      token = await auth.login(c.db, c.body.email, c.body.password, role, { otp: c.body.otp });
    } catch (e) {
      // Answered, not thrown, so the record of the failed attempt (and any lockout) is kept.
      if (!(e instanceof AppError)) throw e;
      if (e.status === 401) await audit(c.db, 'auth.login_failed', 'user', mask(auth.normalEmail(c.body.email)), null, { area });
      return new Reply(e.status, { error: e.message, ...(e.details ? { details: e.details } : {}) });
    }
    if (c.token) await auth.logout(c.db, c.token); // a fresh token at every sign-in
    const user = await auth.userForToken(c.db, token, role);
    setActor(userActor(user));
    await audit(c.db, 'auth.login', 'user', user.id, null, { area });
    return new Reply(200, { user }, [area, token]);
  }, true);
  route('POST', area, '/logout', async (c) => {
    if (c.token) await auth.logout(c.db, c.token);
    return new Reply(200, { ok: true }, [area, '']);
  }, true);
  route('POST', area, '/logout-all', async (c) => {
    await auth.logoutEverywhere(c.db, c.user.id);
    return new Reply(200, { ok: true }, [area, '']);
  });
  // Forgotten passwords: a one-time code by email (the outbox, until Phase 10).
  route('POST', area, '/password/forgot', async (c) => {
    await auth.requestPasswordReset(c.db, c.body.email, role, area);
    return { ok: true, message: 'If that email has an account here, we sent a reset code to it.' };
  }, true);
  route('POST', area, '/password/reset', async (c) => {
    const b = c.body;
    if (!(await auth.resetPassword(c.db, b.email, role, b.code, b.password))) {
      return new Reply(400, { error: "That code isn't right or has expired. Ask for a new one." });
    }
    return { ok: true };
  }, true);
  route('GET', area, '/me', async (c) => ({ user: c.user, demo: auth.demoMode() }), true);
  route('GET', area, '/notifications', async (c) => await notify.listFor(c.db, c.user.id));
  route('POST', area, '/notifications/read', async (c) => {
    await notify.markRead(c.db, c.user.id);
    return { ok: true };
  });
}

// Connect a Telegram chat: a signed-in person asks for a one-time code here, then sends
// "/start <code>" to the bot. The bot never asks for a password.
for (const area of ['shop', 'seller']) {
  route('POST', area, '/telegram/link-code', async (c) => {
    const out = await telegram.issueLinkCode(c.db, c.user);
    await audit(c.db, 'telegram.link_code', 'user', c.user.id, null, { expires_in_seconds: out.expires_in_seconds });
    return { ...out, bot: telegram.botUsername(), command: `/start ${out.code}` };
  });
}

// Two-step sign-in with an authenticator app, for sellers and staff.
for (const area of ['seller', 'ops']) {
  route('GET', area, '/2fa', async (c) => await auth.twoStepStatus(c.db, c.user.id));
  route('POST', area, '/2fa/setup', async (c) => await auth.setupTotp(c.db, c.user));
  for (const [path, enable] of [['/2fa/enable', true], ['/2fa/disable', false]]) {
    route('POST', area, path, async (c) => {
      if (!(await auth.confirmTotp(c.db, c.user.id, c.body.code, enable))) {
        return new Reply(400, { error: "That code isn't right. Check the time on your phone and try again." });
      }
      return await auth.twoStepStatus(c.db, c.user.id);
    });
  }
}

// ---------------------------------------------------------------- shop (customer)

route('GET', 'shop', '/meta', async () => ({
  cities: catalog.CITIES, categories: catalog.CATEGORIES, payment_options: PAYMENT_OPTIONS,
  sample_notice: SAMPLE_NOTICE, rank_weights: catalog.RANK_WEIGHTS,
}), true);

// Sign-up: the account works once the code emailed to it is entered.
route('POST', 'shop', '/register', async (c) => {
  const b = c.body;
  await auth.startSignUp(c.db, b.email, b.name, b.password);
  return new Reply(201, { needs_verification: true, email: auth.normalEmail(b.email) });
}, true);
route('POST', 'shop', '/verify-email', async (c) => {
  const userId = await auth.verifyEmail(c.db, c.body.email, c.body.code);
  if (!userId) return new Reply(400, { error: "That code isn't right or has expired. Ask for a new one." });
  const token = await auth.issueSession(c.db, userId, 'customer');
  const user = await auth.userForToken(c.db, token, 'customer');
  setActor(userActor(user));
  return new Reply(200, { user }, ['shop', token]);
}, true);
route('POST', 'shop', '/verify-email/resend', async (c) => {
  await auth.resendVerification(c.db, c.body.email);
  return { ok: true };
}, true);

route('GET', 'shop', '/search', async (c) => {
  const city = await c.city();
  return {
    city,
    ...await catalog.searchPage(c.db, {
      q: c.q('q', ''), category: c.q('category') || null, sort: c.q('sort', 'relevance'), city,
      page: c.q('page', 1), pageSize: c.q('page_size', catalog.PAGE_SIZE),
    }),
  };
}, true);

route('GET', 'shop', '/products/(\\d+)', async (c, pid) => await catalog.productDetail(c.db, int(pid), await c.city()), true);
route('GET', 'shop', '/cart', async (c) => await orders.getCart(c.db, c.user.id));
route('POST', 'shop', '/cart', async (c) => {
  await orders.addToCart(c.db, c.user.id, int(c.body.offer_id ?? 0), c.body.qty ?? 1);
  return await orders.getCart(c.db, c.user.id);
});
route('PUT', 'shop', '/cart/(\\d+)', async (c, offerId) => {
  await orders.setCartQty(c.db, c.user.id, int(offerId), c.body.qty ?? 0);
  return await orders.getCart(c.db, c.user.id);
});
route('DELETE', 'shop', '/cart/(\\d+)', async (c, offerId) => {
  await orders.setCartQty(c.db, c.user.id, int(offerId), 0);
  return await orders.getCart(c.db, c.user.id);
});
route('GET', 'shop', '/addresses', async (c) => await orders.listAddresses(c.db, c.user.id));
route('POST', 'shop', '/addresses', async (c) => {
  await orders.addAddress(c.db, c.user.id, c.body);
  return new Reply(201, await orders.listAddresses(c.db, c.user.id));
});
route('POST', 'shop', '/checkout/preview', async (c) => await orders.checkoutPreview(c.db, c.user.id, c.body.address_id));
// With an idempotency_key (the page makes one per "Place your order" click), the same request
// sent twice gets the first answer back instead of a second order. The second request waits on
// the key's row until the first commits; if the first failed and rolled back, the key is free
// again and the second goes ahead.
route('POST', 'shop', '/orders', async (c) => {
  const key = c.body.idempotency_key;
  if (key == null) return await placeOrderReply(c);
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
    throw new AppError(400, 'idempotency_key must be 8-100 letters, digits, - or _.');
  }
  const fresh = await changes(c.db, `INSERT INTO idempotency_keys (user_id, key, route) VALUES (?,?, 'shop.orders')
                                     ON CONFLICT (user_id, key) DO NOTHING`, c.user.id, key);
  if (!fresh) {
    const first = await one(c.db, 'SELECT status, response FROM idempotency_keys WHERE user_id = ? AND key = ?', c.user.id, key);
    return new Reply(first.status, first.response);
  }
  const reply = await placeOrderReply(c);
  await run(c.db, 'UPDATE idempotency_keys SET status = ?, response = ? WHERE user_id = ? AND key = ?',
    reply.status, JSON.stringify(reply.payload), c.user.id, key);
  return reply;
}, false, {
  // A bank-transfer order is checked against the bank statement: fetch it before the
  // transaction so no database rows are locked during the network call.
  prepare: (body) => (body.payment_method === 'bank' ? loadStatement() : null),
});

async function placeOrderReply(c) {
  const b = c.body;
  const res = await orders.placeOrder(c.db, c.user.id, b.address_id, b.payment_method, b.payment_token, { statement: c.prepared });
  if (res.result === 'issues') {
    return new Reply(409, { error: 'Your cart changed since you last looked. Please review the updates.',
      details: { issues: res.issues, totals: res.totals } });
  }
  if (res.result === 'payment_failed') {
    const why = res.order.payment.decline_reason;
    return new Reply(402, {
      error: b.payment_method === 'bank'
        ? `We couldn't confirm your payment: ${why} Your cart is saved.`
        : `Payment was declined (${why}). Nothing was charged and your cart is saved.`,
      details: { order: res.order },
    });
  }
  return new Reply(201, res.order);
}
route('GET', 'shop', '/orders', async (c) => await orders.listOrders(c.db, c.user.id));
route('GET', 'shop', '/orders/(\\d+)', async (c, oid) => await orders.getOrder(c.db, int(oid), c.user.id));
route('POST', 'shop', '/orders/(\\d+)/cancel', async (c, oid) => await orders.cancelOrder(c.db, c.user.id, int(oid)));
route('POST', 'shop', '/orders/(\\d+)/returns', async (c, oid) => {
  const b = c.body;
  await orders.requestReturn(c.db, c.user.id, int(oid), int(b.order_item_id ?? 0), b.qty ?? 1, b.reason);
  return new Reply(201, await orders.getOrder(c.db, int(oid), c.user.id));
});
route('POST', 'shop', '/shipments/(\\d+)/confirm', async (c, sid) => {
  await orders.confirmDelivery(c.db, c.user.id, int(sid));
  return { ok: true };
});
route('GET', 'shop', '/support', async (c) => await orders.listTickets(c.db, c.user.id));
route('POST', 'shop', '/support', async (c) => {
  await orders.createTicket(c.db, c.user.id, c.body.order_id, c.body.subject, c.body.message);
  return new Reply(201, await orders.listTickets(c.db, c.user.id));
});
route('POST', 'shop', '/support/(\\d+)/reply', async (c, tid) => {
  await orders.replyTicket(c.db, int(tid), 'customer', c.body.message, false, c.user.id);
  return await orders.listTickets(c.db, c.user.id);
});

route('GET', 'shop', '/assistant', async () => ({ available: assistant.isAvailable() }), true);
route('POST', 'shop', '/assistant', async (c) =>
  assistant.answer(c.db, {
    user: c.user, city: await c.city(), voice: c.body.voice === true, language: c.body.language === 'te' ? 'te' : 'en',
  }, c.body.messages), false, { readOnly: true });

// ---------------------------------------------------------------- Seller Central

route('GET', 'seller', '/meta', async () => ({
  cities: catalog.CITIES, categories: catalog.CATEGORIES, sample_notice: SAMPLE_NOTICE,
  price_review_threshold: listings.PRICE_REVIEW_THRESHOLD,
}));
route('GET', 'seller', '/dashboard', async (c) => {
  const sid = c.user.seller_id;
  const data = await listings.sellerListings(c.db, sid);
  const items = await orders.sellerOrders(c.db, sid);
  return {
    active_listings: data.offers.filter((o) => o.status === 'active').length,
    low_stock: data.offers.filter((o) => o.status === 'active' && o.available < 5),
    pending_reviews: (await listings.listSubmissions(c.db, sid, 'pending')).length,
    to_dispatch: items.filter((i) => i.seller_can_advance && i.order_status === 'confirmed').length,
    open_orders: items.filter((i) => i.order_status === 'confirmed').length,
    balance_paise: (await orders.sellerLedger(c.db, sid)).balance_paise,
  };
});
route('GET', 'seller', '/listings', async (c) => await listings.sellerListings(c.db, c.user.seller_id));
route('GET', 'seller', '/catalog', async (c) => await listings.catalogLookup(c.db, c.q('q', '')));
route('GET', 'seller', '/submissions', async (c) => await listings.listSubmissions(c.db, c.user.seller_id));
route('POST', 'seller', '/submissions', async (c) => new Reply(201, await listings.submit(c.db, c.user.seller_id, c.body)));
route('GET', 'seller', '/orders', async (c) => await orders.sellerOrders(c.db, c.user.seller_id));
route('POST', 'seller', '/shipments/(\\d+)/advance', async (c, sid) => await orders.advanceShipment(c.db, int(sid), 'seller', c.user.seller_id));
route('GET', 'seller', '/ledger', async (c) => await orders.sellerLedger(c.db, c.user.seller_id));
route('GET', 'seller', '/assistant', async () => ({ available: assistant.isAvailable() }));
route('POST', 'seller', '/assistant', async (c) => answerSeller(c.db, { user: c.user, voice: c.body.voice === true, language: c.body.language === 'te' ? 'te' : 'en' }, c.body.messages), false, { readOnly: true });

// ---------------------------------------------------------------- Equidron Ops

route('GET', 'ops', '/overview', async (c) => {
  const n = (sql) => scalar(c.db, sql);
  return {
    pending_reviews: await n("SELECT COUNT(*) FROM submissions WHERE status = 'pending'"),
    active_shipments: await n("SELECT COUNT(*) FROM shipments WHERE status NOT IN ('delivered', 'cancelled')"),
    open_returns: await n("SELECT COUNT(*) FROM returns WHERE status = 'pickup_scheduled'"),
    open_tickets: await n("SELECT COUNT(*) FROM support_tickets WHERE status = 'open'"),
    unsettled_paise: await n('SELECT COALESCE(SUM(amount_paise), 0) FROM seller_ledger'),
    pending_approvals: await n("SELECT COUNT(*) FROM approvals WHERE status = 'pending'"),
    open_tasks: await n("SELECT COUNT(*) FROM ops_tasks WHERE status = 'open'"),
    agents_paused: await agents.allPaused(c.db),
    sample_notice: SAMPLE_NOTICE,
  };
});
route('GET', 'ops', '/submissions', async (c) => await listings.listSubmissions(c.db, null, c.q('status') || null));
route('POST', 'ops', '/submissions/(\\d+)/decide', async (c, sid) =>
  await listings.decide(c.db, int(sid), Boolean(c.body.approve), String(c.body.note || '').trim(), c.user.id));
route('GET', 'ops', '/shipments', async (c) => await orders.listShipments(c.db, c.q('all') !== '1'));
route('POST', 'ops', '/shipments/(\\d+)/advance', async (c, sid) => await orders.advanceShipment(c.db, int(sid), 'ops'));
route('POST', 'ops', '/shipments/advance-all', async (c) => {
  const active = await orders.listShipments(c.db);
  // Guardrail: a bulk click must never touch an unbounded number of records.
  capBulk(active.length, { label: 'shipments' });
  for (const s of active) await orders.advanceShipment(c.db, s.id, 'ops');
  return { advanced: active.length };
});
route('GET', 'ops', '/returns', async (c) => await orders.listReturns(c.db));
route('POST', 'ops', '/returns/(\\d+)/receive', async (c, rid) =>
  ({ refunded_paise: await orders.receiveReturn(c.db, int(rid), c.body.restock !== false, c.user.id) }));
route('POST', 'ops', '/returns/(\\d+)/reject', async (c, rid) => {
  await orders.rejectReturn(c.db, int(rid), String(c.body.note || '').trim(), c.user.id);
  return { ok: true };
});
route('GET', 'ops', '/support', async (c) => await orders.listTickets(c.db));
route('POST', 'ops', '/support/(\\d+)/reply', async (c, tid) => {
  await orders.replyTicket(c.db, int(tid), 'ops', c.body.message, Boolean(c.body.close));
  return await orders.listTickets(c.db);
});
route('POST', 'ops', '/settlement/run', async (c) => ({ payouts: await orders.runSettlement(c.db) }));
route('GET', 'ops', '/staff', async (c) => ({ staff: await auth.staffList(c.db), permissions: auth.PERMISSIONS }));
route('POST', 'ops', '/staff/(\\d+)/permissions', async (c, uid) => await auth.setPermissions(c.db, int(uid), c.body.permissions, c.user.id));
route('GET', 'ops', '/audit', async (c) => mask(await listAudit(c.db, { entity: c.q('entity') || null })));
route('GET', 'ops', '/outbox', async (c) => await listOutbox(c.db)); // admin only: it holds sign-up and reset codes

// The System page (admin): the job queue, dead jobs, recent errors and the switches.
route('GET', 'ops', '/system', async (c) => ({
  jobs: await jobs.queueStats(c.db),
  dead: await all(c.db, "SELECT id, kind, attempts, last_error, finished_at FROM jobs WHERE status = 'dead' ORDER BY id DESC LIMIT 50"),
  recent: await all(c.db, 'SELECT id, kind, status, attempts, run_after, finished_at FROM jobs ORDER BY id DESC LIMIT 30'),
  errors: await all(c.db, 'SELECT id, source, request_id, message, at FROM error_log ORDER BY id DESC LIMIT 50'),
  settings: await jobs.allSettings(c.db),
  events_waiting: await scalar(c.db, 'SELECT COUNT(*) FROM events WHERE dispatched_at IS NULL'),
}));
route('POST', 'ops', '/jobs/(\\d+)/retry', async (c, jid) => {
  if (!(await jobs.retry(c.db, int(jid)))) throw new AppError(409, 'Only failed or dead jobs can be retried.');
  await audit(c.db, 'job.retry', 'job', jid);
  return { ok: true };
});
route('POST', 'ops', '/settings', async (c) => {
  const { key, value } = c.body;
  if (!Object.hasOwn(jobs.SETTINGS, key) || typeof value !== typeof jobs.SETTINGS[key]) {
    throw new AppError(400, `Choose one of: ${Object.keys(jobs.SETTINGS).join(', ')}.`);
  }
  const before = await jobs.getSetting(c.db, key);
  await jobs.setSetting(c.db, key, value);
  await audit(c.db, 'setting.change', 'setting', key, { value: before }, { value });
  return await jobs.allSettings(c.db);
});
// A deliberate error, to check that errors reach the error log (and Sentry, when it is set up).
route('POST', 'ops', '/system/test-error', async () => {
  throw new Error('Test error from Ops → System (on purpose).');
});

// ---------------------------------------------------------------- agents

// The Agents page: the switches, levels, models and budgets, today's spending, and the big
// red button. Every route here is unlisted in OPS_PERMISSIONS, so it needs the admin permission.
route('GET', 'ops', '/agents', async (c) => {
  const list = await agents.listAgents(c.db);
  return {
    // Agreement is what earns an agent more freedom, so it sits next to the switches.
    agents: await Promise.all(list.map(async (a) => ({ ...a, agreement: await agents.agreement(c.db, a.id) }))),
    paused: await agents.allPaused(c.db),
    levels: agents.LEVELS,
    spent_today_usd: await agents.spendToday(c.db),
    brief: await one(c.db, `SELECT summary, started_at FROM agent_runs
                            WHERE agent_id = 'daily_brief' AND status = 'done' AND summary IS NOT NULL
                            ORDER BY id DESC LIMIT 1`),
    open_tasks: await scalar(c.db, "SELECT COUNT(*) FROM ops_tasks WHERE status = 'open'"),
  };
});
route('POST', 'ops', '/agents/pause-all', async (c) => {
  const paused = Boolean(c.body.paused);
  const before = await agents.allPaused(c.db);
  await agents.pauseAll(c.db, paused);
  await audit(c.db, 'agents.pause_all', 'setting', 'agents.paused', { paused: before }, { paused });
  return { paused };
});
route('POST', 'ops', '/agents/([a-z][a-z0-9_]*)', async (c, id) => {
  const before = await agents.getAgent(c.db, id);
  if (!before) throw new AppError(404, 'There is no such agent.');
  const after = await agents.updateAgent(c.db, id, {
    enabled: c.body.enabled === undefined ? undefined : c.body.enabled,
    autonomy_level: c.body.autonomy_level === undefined ? undefined : int(c.body.autonomy_level),
    model: c.body.model,
    max_steps: c.body.max_steps === undefined ? undefined : int(c.body.max_steps),
    daily_budget_usd: c.body.daily_budget_usd,
  });
  await audit(c.db, 'agent.update', 'agent', id,
    { enabled: before.enabled, autonomy_level: before.autonomy_level, model: before.model, daily_budget_usd: before.daily_budget_usd },
    { enabled: after.enabled, autonomy_level: after.autonomy_level, model: after.model, daily_budget_usd: after.daily_budget_usd });
  return after;
});
// Run the agent once, by hand, on a task typed in Ops. The runtime writes its own rows, so
// this route runs outside the request transaction (readOnly: it must not hold one for minutes).
route('POST', 'ops', '/agents/([a-z][a-z0-9_]*)/run', async (c, id) => {
  // A task typed by a person, so it is short: a long prompt costs money and is usually a paste.
  const task = String(c.body.task || '').trim().slice(0, 2000) || 'Look at the most recent open case and do what is right.';
  const run = await runAgent(c.db, {
    agentId: id,
    task,
    trigger: 'ops',
    subject: c.body.subject ? String(c.body.subject).slice(0, 100) : null,
  });
  return new Reply(201, run);
}, false, { readOnly: true });

// The Approvals inbox: what is waiting, and the one place a person says yes or no.
route('GET', 'ops', '/approvals', async (c) => ({
  approvals: await approvals.listApprovals(c.db, c.q('status', 'pending')),
  pending: await approvals.countPending(c.db),
}));
route('POST', 'ops', '/approvals/(\\d+)/decide', async (c, id) =>
  await approvals.decideApproval(c.db, int(id), {
    approve: c.body.approve === true,
    byUserId: c.user.id,
    note: c.body.note ? String(c.body.note).trim().slice(0, 500) : null,
  }));

// Guardrails: what the rules stopped or flagged, for every role (customer, seller, staff).
route('GET', 'ops', '/guardrails', async (c) => ({
  events: await recentGuardrails(c.db, 100),
  counts: await guardrailCounts(c.db),
}));

// Work items the agents raised (Fulfilment Watch opens one per shipment twice as late). A
// person closes them; the agent's job only ever opens them.
route('GET', 'ops', '/tasks', async (c) => ({
  tasks: await all(c.db, "SELECT * FROM ops_tasks WHERE status = 'open' ORDER BY created_at, id LIMIT 100"),
  done: await all(c.db, "SELECT * FROM ops_tasks WHERE status = 'done' ORDER BY closed_at DESC, id DESC LIMIT 20"),
}));

// The incidents dashboard: one answer to "is anything wrong right now?".
route('GET', 'ops', '/incidents', async (c) => await incidents.snapshot(c.db));
route('POST', 'ops', '/tasks/(\\d+)/done', async (c, id) => {
  const task = await one(c.db, "SELECT id FROM ops_tasks WHERE id = ? AND status = 'open'", int(id));
  if (!task) throw new AppError(409, 'That task is already done.');
  await run(c.db, "UPDATE ops_tasks SET status = 'done', closed_at = now(), closed_by = ? WHERE id = ? AND status = 'open'", c.user.id, task.id);
  await audit(c.db, 'task.done', 'ops_task', task.id, { status: 'open' }, { status: 'done' });
  return { ok: true };
});

// Analytics: who sells the most, revenue per seller per quarter, and customers to promote.
// months is a whole number of months, 1 to 60.
route('GET', 'ops', '/analytics', async (c) => {
  const months = Math.min(60, Math.max(1, Number(c.q('months', 12)) || 12));
  return await analytics.snapshot(c.db, { months });
});

// The Agent runs page: the list, and one run step by step.
route('GET', 'ops', '/agent-runs', async (c) => {
  const id = c.q('agent');
  return {
    runs: await all(c.db, `SELECT r.*, (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id) AS steps
                            FROM agent_runs r WHERE (?::text IS NULL OR r.agent_id = ?::text)
                            ORDER BY r.id DESC LIMIT 50`, id, id),
  };
});
route('GET', 'ops', '/agent-runs/(\\d+)', async (c, id) => {
  const run = await one(c.db, 'SELECT * FROM agent_runs WHERE id = ?', int(id));
  if (!run) throw new AppError(404, 'There is no such run.');
  return { run, steps: await all(c.db, 'SELECT * FROM agent_steps WHERE run_id = ? ORDER BY step', run.id) };
});

// ---------------------------------------------------------------- dispatch

// Handle one API call. query is a URLSearchParams; cookies a plain object.
// Returns {status, payload, setCookie} where setCookie is a Set-Cookie header value or null.
// Every answer carries a request id (X-Request-Id), which is also on every log line for it.
export async function handleApi(db, request) {
  const requestId = newRequestId();
  const out = await withRequestId(requestId, () => answer(db, request));
  return { ...out, requestId };
}

// Public: is the database answering, and is the queue moving? For an uptime check.
async function health(db) {
  try {
    await one(db, 'SELECT 1 AS ok');
    const lastTick = await jobs.getSetting(db, 'tick.last', null);
    return { status: 200, payload: { status: 'ok', database: 'ok', jobs: await jobs.queueStats(db), last_tick: lastTick }, setCookie: null };
  } catch (e) {
    await reportError(db, 'health', e);
    return { status: 503, payload: { status: 'error', database: 'unavailable' }, setCookie: null };
  }
}

async function answer(db, { method, path, query, body, cookies, headers = {} }) {
  if (path === '/api/health' && method === 'GET') return await health(db);
  // Telegram's webhook: not an area route, and it authenticates with its own secret header.
  if (path === '/api/telegram' && method === 'POST') return await telegram.webhookReply(db, { headers, body });
  try {
    const m = /^\/api\/(shop|seller|ops)(\/.*)$/.exec(path);
    if (!m) throw new AppError(404, 'Unknown API endpoint.');
    const [, area, sub] = m;
    for (const r of ROUTES) {
      if (r.area !== area || r.method !== method) continue;
      const pm = r.pattern.exec(sub);
      if (!pm) continue;
      // Reads run directly; anything else runs as one transaction.
      const prepared = r.prepare ? await r.prepare(body || {}) : null;
      const writes = method !== 'GET' && !r.readOnly;
      const scope = writes ? (fn) => transaction(db, fn) : (fn) => fn();
      const result = await actingAs(ANONYMOUS, () => scope(async () => {
        const token = cookies[`eq_${area}`] || null;
        const user = await auth.userForToken(db, token, AREAS[area]);
        if (!user && !r.isPublic) throw new AppError(401, 'Please sign in.');
        if (user) setActor(userActor(user));
        if (r.permission && !auth.hasPermission(user, r.permission)) {
          throw new AppError(403, `You need the "${r.permission}" permission for this. Ask an Equidron admin.`);
        }
        const ctx = {
          db, user, body: body || {}, token, prepared,
          q: (name, fallback = null) => (query.has(name) ? query.get(name) : fallback),
          async city() {
            const city = this.q('city');
            if (catalog.CITIES.includes(city)) return city;
            if (user && user.role === 'customer') {
              const a = await one(db, 'SELECT city FROM addresses WHERE user_id = ? ORDER BY id LIMIT 1', user.id);
              return a ? a.city : null;
            }
            return null;
          },
        };
        const out = await r.fn(ctx, ...pm.slice(1));
        if (writes && !auditsWritten()) await audit(db, r.action, r.entity, pm[1] ?? '-', null, { request: safeBody(body) });
        return out;
      }));
      const reply = result instanceof Reply ? result : new Reply(200, result);
      let setCookie = null;
      if (reply.cookie) {
        const [a, tok] = reply.cookie;
        setCookie = `eq_${a}=${tok}; Path=/api/${a}; HttpOnly; SameSite=Lax${tok ? '' : '; Max-Age=0'}`;
      }
      return { status: reply.status, payload: reply.payload, setCookie };
    }
    throw new AppError(404, 'Unknown API endpoint.');
  } catch (e) {
    if (e instanceof AppError) {
      const payload = { error: e.message };
      if (e.details != null) payload.details = e.details;
      return { status: e.status, payload, setCookie: null };
    }
    await reportError(db, `api ${method} ${path}`, e); // outside the failed transaction, so the record stays
    return { status: 500, payload: { error: 'Something went wrong on our side. Please try again.', request_id: requestId() }, setCookie: null };
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------------------------------------------------------------- placeholder product images

const CATEGORY_STYLE = {
  Phones: ['#1f4e79', '📱'], Laptops: ['#3d3b8e', '💻'], Audio: ['#7a2e5a', '🎧'], Wearables: ['#0f6b5c', '⌚'],
  'Home & Kitchen': ['#8a5a14', '🍳'], Books: ['#5b3a29', '📚'], Grocery: ['#4f6b18', '☕'], Fashion: ['#8c2f39', '👟'],
};
const VIEW_LABELS = { 1: 'Front', 2: 'Back', 3: 'Detail' };
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[ch]);

export async function placeholderSvg(db, name) {
  const m = /^p(\d+)-(\d+)$/.exec(name);
  const p = m && await one(db, 'SELECT title, brand, category FROM products WHERE id = ?', Number(m[1]));
  let color; let icon; let brand; let label; let lines;
  if (p) {
    [color, icon] = CATEGORY_STYLE[p.category] || ['#444', '📦'];
    brand = p.brand;
    label = VIEW_LABELS[Number(m[2])] || 'View';
    lines = [];
    let line = '';
    for (const w of p.title.split(/\s+/)) {
      if (line.length + w.length > 26 && line) {
        lines.push(line);
        line = w;
      } else line = `${line} ${w}`.trim();
    }
    lines = [...lines, line].slice(0, 3);
  } else {
    [color, icon, brand, label, lines] = ['#555', '📦', 'Seller image', 'Placeholder', [name.replace(/-/g, ' ')]];
  }
  const text = lines.map((t, i) =>
    `<text x="200" y="${300 + 24 * i}" font-size="17" text-anchor="middle" fill="#fff" opacity=".92">${esc(t)}</text>`).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">' +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/>` +
    '<stop offset="1" stop-color="#111827"/></linearGradient></defs>' +
    '<rect width="400" height="400" fill="url(#g)"/>' +
    `<text x="200" y="190" font-size="110" text-anchor="middle">${icon}</text>` +
    `<text x="200" y="262" font-size="26" font-weight="700" text-anchor="middle" fill="#fff" font-family="sans-serif">${esc(brand)}</text>` +
    `<g font-family="sans-serif">${text}</g>` +
    `<text x="16" y="28" font-size="13" fill="#fff" opacity=".7" font-family="sans-serif">${esc(label)} · sample image</text></svg>`;
}
