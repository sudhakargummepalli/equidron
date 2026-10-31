package in.equidron.ops;

import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * The rest of the Ops panels: the lists staff open and look at.
 *
 * These are reads over rows that already exist, so nothing here decides anything - the decisions live
 * in the settlement and approval controllers. Staff only, for the same reason: a seller reading the
 * outbox would see other people's addresses, and reading the audit log is how you work out who did
 * what.
 */
@RestController
@RequestMapping("/api/ops")
public class OpsPanelsController {

    private final JdbcTemplate jdbc;
    private final SessionService sessions;
    private final UserRepository users;

    public OpsPanelsController(JdbcTemplate jdbc, SessionService sessions, UserRepository users) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.users = users;
    }

    private void staff(String token) {
        UserRepository.User user = sessions.resolve(token, users);
        if (user == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Please sign in.");
        if (!"ops".equals(user.role()) && !"admin".equals(user.role())) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Staff only.");
    }

    /**
     * Payout batches, with the lines that explain them.
     *
     * Approving a settlement needs what is paid, who receives it, how much arrives after tax and the reason
     * recorded on the batch. A single total is not something a person can responsibly approve.
     */
    @GetMapping("/payouts")
    public Map<String, Object> payouts(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        List<Map<String, Object>> batches = jdbc.queryForList(
            "SELECT b.id, b.status, b.total_paise, b.note, b.created_at, b.decided_at, " +
            "       (SELECT count(*) FROM payout_lines l WHERE l.batch_id = b.id) AS sellers, " +
            "       (SELECT COALESCE(SUM(l.net_paise), 0) FROM payout_lines l WHERE l.batch_id = b.id) AS net_paise " +
            "FROM payout_batches b ORDER BY b.id DESC LIMIT 50");
        List<Map<String, Object>> allLines = jdbc.queryForList(
            "SELECT l.batch_id, s.name AS seller, l.gross_paise, l.tcs_paise, l.tds_paise, l.net_paise " +
            "FROM payout_lines l JOIN sellers s ON s.id = l.seller_id " +
            "WHERE l.batch_id IN (SELECT id FROM payout_batches ORDER BY id DESC LIMIT 50) " +
            "ORDER BY l.batch_id DESC, l.id");
        List<Map<String, Object>> out = new java.util.ArrayList<>();
        for (Map<String, Object> batch : batches) {
            Map<String, Object> view = new java.util.LinkedHashMap<>(batch);
            view.put("lines", allLines.stream().filter(x -> x.get("batch_id").equals(batch.get("id"))).toList());
            out.add(view);
        }
        return Map.of("batches", out);
    }

    @GetMapping("/returns")
    public List<Map<String, Object>> returns(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return jdbc.queryForList(
            "SELECT r.id, r.order_id, r.qty, r.reason, r.status, r.refund_paise, r.pickup_status, r.pickup_at, " +
            "       r.pickup_courier, r.created_at, u.email " +
            "FROM returns r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 100");
    }

    @GetMapping("/support")
    public List<Map<String, Object>> support(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return jdbc.queryForList(
            "SELECT t.id, t.subject, t.status, t.created_at, u.email, " +
            "       (SELECT count(*) FROM support_messages m WHERE m.ticket_id = t.id) AS messages " +
            "FROM support_tickets t JOIN users u ON u.id = t.user_id ORDER BY t.id DESC LIMIT 100");
    }

    @GetMapping("/audit")
    public List<Map<String, Object>> audit(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return jdbc.queryForList(
            "SELECT id, actor_type, actor_id, action, entity, entity_id, at FROM audit_log ORDER BY id DESC LIMIT 100");
    }

    /** Sign-up and reset codes pass through here, which is why it is staff only. */
    @GetMapping("/outbox")
    public List<Map<String, Object>> outbox(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return jdbc.queryForList(
            "SELECT id, channel, to_address, subject, status, attempts, last_error, at, sent_at " +
            "FROM outbox ORDER BY id DESC LIMIT 50");
    }

    @GetMapping("/shipments")
    public List<Map<String, Object>> shipments(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return jdbc.queryForList(
            "SELECT s.id, s.order_id, s.status, s.carrier, s.tracking_no, s.amount_paise, s.eta, s.awb, s.created_at, " +
            "       w.name AS warehouse " +
            "FROM shipments s LEFT JOIN warehouses w ON w.id = s.warehouse_id ORDER BY s.id DESC LIMIT 100");
    }

    @GetMapping("/submissions")
    public List<Map<String, Object>> submissions(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return jdbc.queryForList(
            "SELECT s.id, s.kind, s.status, s.auto_decided, s.review_reasons, s.created_at, sel.name AS seller " +
            "FROM submissions s LEFT JOIN sellers sel ON sel.id = s.seller_id ORDER BY s.id DESC LIMIT 100");
    }

    @GetMapping("/agent-runs")
    public Map<String, Object> agentRuns(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return Map.of("runs", jdbc.queryForList(
            "SELECT id, agent_id, trigger, subject, status, input_tokens, output_tokens, cost_usd, started_at, finished_at " +
            "FROM agent_runs ORDER BY id DESC LIMIT 50"));
    }

    @GetMapping("/agent-runs/{id}")
    public Map<String, Object> agentRun(@CookieValue(name = "equidron_session", required = false) String token,
                                        @PathVariable long id) {
        staff(token);
        List<Map<String, Object>> runs = jdbc.queryForList(
            "SELECT id, agent_id, trigger, subject, status, summary, error, cost_usd, started_at, finished_at " +
            "FROM agent_runs WHERE id = ?", id);
        if (runs.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No such run.");
        Map<String, Object> out = new LinkedHashMap<>(runs.get(0));
        out.put("steps", jdbc.queryForList(
            "SELECT step, kind, tool, decision, input, output, at FROM agent_steps WHERE run_id = ? ORDER BY step", id));
        return out;
    }

    @GetMapping("/guardrails")
    public Map<String, Object> guardrails(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return Map.of(
            "events", jdbc.queryForList(
                "SELECT id, role, area, rule, severity, actor_id, detail, at FROM guardrail_events ORDER BY id DESC LIMIT 100"),
            "counts", jdbc.queryForMap(
                "SELECT COALESCE(SUM(CASE WHEN severity = 'refuse' THEN 1 ELSE 0 END), 0) AS refusals, " +
                "       COALESCE(SUM(CASE WHEN severity = 'flag' THEN 1 ELSE 0 END), 0) AS flags FROM guardrail_events"));
    }

    @GetMapping("/incidents")
    public List<Map<String, Object>> incidents(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return jdbc.queryForList(
            "SELECT id, source, request_id, message, at FROM error_log ORDER BY id DESC LIMIT 100");
    }

    /** Month-by-month money and volume: what an owner asks for first. */
    @GetMapping("/analytics")
    public Map<String, Object> analytics(@CookieValue(name = "equidron_session", required = false) String token,
                                         @RequestParam(name = "months", defaultValue = "6") int months) {
        staff(token);
        int span = Math.min(24, Math.max(1, months));
        return Map.of(
            "months", jdbc.queryForList(
                "SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, " +
                "       count(*) AS orders, SUM(total_paise) AS revenue_paise " +
                "FROM orders WHERE created_at >= date_trunc('month', now()) - make_interval(months => ?) " +
                "GROUP BY 1 ORDER BY 1", span),
            "top_sellers", jdbc.queryForList(
                "SELECT s.name, SUM(oi.qty * oi.unit_price_paise) AS revenue_paise " +
                "FROM order_items oi JOIN sellers s ON s.id = oi.seller_id " +
                "GROUP BY s.name ORDER BY revenue_paise DESC LIMIT 5"));
    }

    @GetMapping("/system")
    public Map<String, Object> system(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return Map.of(
            "database", "ok",
            "jobs", jdbc.queryForMap(
                "SELECT count(*) FILTER (WHERE status = 'queued') AS queued, " +
                "       count(*) FILTER (WHERE status = 'running') AS running, " +
                "       count(*) FILTER (WHERE status = 'dead') AS dead FROM jobs"),
            "outbox", jdbc.queryForMap(
                "SELECT count(*) FILTER (WHERE status = 'queued') AS queued, " +
                "       count(*) FILTER (WHERE status = 'failed') AS failed FROM outbox"),
            "settings", jdbc.queryForMap("SELECT COALESCE(json_object_agg(key, value), '{}'::json) AS settings FROM settings"));
    }

    /** Staff accounts and what each may do. The permission table is per-deployment, so it is empty here. */
    @GetMapping("/staff")
    public List<Map<String, Object>> staffList(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return jdbc.queryForList(
            "SELECT id, email, name, role FROM users WHERE role IN ('ops', 'admin') ORDER BY id");
    }

    /** Follow-ups people keep for themselves. Empty rather than absent, so the panel loads. */
    @GetMapping("/tasks")
    public Map<String, Object> tasks(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return Map.of("tasks", List.of(), "done", List.of());
    }

    /** There is no tasks table in this build, so closing one is a no-op that still answers. */
    @PostMapping("/tasks/{id}/done")
    public Map<String, Object> closeTask(@CookieValue(name = "equidron_session", required = false) String token,
                                         @PathVariable long id) {
        staff(token);
        return Map.of("ok", true, "id", id);
    }

    @PostMapping("/jobs/{id}/retry")
    public Map<String, Object> retryJob(@CookieValue(name = "equidron_session", required = false) String token,
                                        @PathVariable long id) {
        staff(token);
        int changed = jdbc.update(
            "UPDATE jobs SET status = 'queued', run_after = now(), attempts = 0, locked_until = NULL, last_error = NULL " +
            "WHERE id = ? AND status IN ('dead', 'failed')", id);
        if (changed == 0) throw new ResponseStatusException(HttpStatus.CONFLICT, "That job is not waiting to be retried.");
        return Map.of("ok", true, "id", id);
    }

    @PostMapping("/system/test-error")
    public Map<String, Object> testError(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        jdbc.update("INSERT INTO error_log (source, message, at) VALUES ('ops-test', 'Test error from Ops', now())");
        return Map.of("ok", true);
    }

    @PostMapping("/settings")
    public Map<String, Object> saveSetting(@CookieValue(name = "equidron_session", required = false) String token,
                                           @RequestBody Map<String, Object> body) {
        staff(token);
        String key = String.valueOf(body.get("key"));
        String value = String.valueOf(body.get("value"));
        jdbc.update("INSERT INTO settings (key, value) VALUES (?, ?::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", key, value);
        return Map.of("ok", true, "key", key, "value", value);
    }
}
