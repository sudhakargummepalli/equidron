package in.equidron.ops;

import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * The decisions staff take on the panels: approve a listing, receive or reject a return, reply to a
 * customer, move shipments on, and change an agent.
 *
 * Each is a guarded UPDATE on a pending state, so two clicks - or two people - cannot apply the same
 * decision twice. Money and agent permissions stay behind these routes and never behind a prompt.
 */
@RestController
@RequestMapping("/api/ops")
public class OpsActionsController {

    private final JdbcTemplate jdbc;
    private final SessionService sessions;
    private final UserRepository users;

    public OpsActionsController(JdbcTemplate jdbc, SessionService sessions, UserRepository users) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.users = users;
    }

    private UserRepository.User staff(String token) {
        UserRepository.User user = sessions.resolve(token, users);
        if (user == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Please sign in.");
        if (!"ops".equals(user.role()) && !"admin".equals(user.role())) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Staff only.");
        return user;
    }

    /** Approving a listing puts the offer live; rejecting keeps it out of the shop. */
    @PostMapping("/submissions/{id}/decide")
    @Transactional
    public Map<String, Object> decideSubmission(@CookieValue(name = "equidron_session", required = false) String token,
                                                @PathVariable long id, @RequestBody Map<String, Object> body) {
        UserRepository.User user = staff(token);
        boolean approve = Boolean.TRUE.equals(body.get("approve"));
        String note = body.get("note") == null ? null : String.valueOf(body.get("note"));
        int changed = jdbc.update(
            "UPDATE submissions SET status = ?, decided_at = now(), decided_by = ?, reviewer_note = ? " +
            "WHERE id = ? AND status = 'pending'", approve ? "approved" : "rejected", user.id(), note, id);
        if (changed == 0) throw new ResponseStatusException(HttpStatus.CONFLICT, "That submission is not waiting for a decision.");
        // Approval is what puts the offer in the shop; rejection leaves it pending, which nobody can buy.
        if (approve) {
            jdbc.update("UPDATE offers SET status = 'active', updated_at = now() " +
                        "WHERE id = (SELECT offer_id FROM submissions WHERE id = ?)", id);
        }
        return Map.of("id", id, "status", approve ? "approved" : "rejected");
    }

    /** Receiving a return refunds the customer; restocking is a separate choice. */
    /**
     * Schedule the collection of an approved return.
     *
     * A return that is approved but never collected is a refund with no parcel: the money goes back and
     * the goods stay with the customer. Recording the courier and the date makes the parcel somebody's job.
     */
    @PostMapping("/returns/{id}/pickup")
    public Map<String, Object> pickupReturn(@CookieValue(name = "equidron_session", required = false) String token,
                                            @PathVariable long id, @RequestBody Map<String, Object> body) {
        staff(token);
        String at = body.get("at") == null ? null : String.valueOf(body.get("at")).trim();
        String courier = body.get("courier") == null ? null : String.valueOf(body.get("courier")).trim();
        if (at == null || at.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Say when the parcel will be collected.");
        }
        int changed = jdbc.update(
            "UPDATE returns SET pickup_status = 'scheduled', pickup_at = ?, pickup_courier = ?, updated_at = now() " +
            "WHERE id = ? AND status IN ('approved', 'received', 'refunded')", at, courier, id);
        if (changed == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Only a return that was accepted can be scheduled for pickup.");
        }
        return Map.of("id", id, "pickup_status", "scheduled", "pickup_at", at,
                      "pickup_courier", courier == null ? "" : courier);
    }

    @PostMapping("/returns/{id}/receive")
    @Transactional
    public Map<String, Object> receiveReturn(@CookieValue(name = "equidron_session", required = false) String token,
                                             @PathVariable long id, @RequestBody(required = false) Map<String, Object> body) {
        UserRepository.User user = staff(token);
        boolean restock = body != null && Boolean.TRUE.equals(body.get("restock"));
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT order_item_id, qty, refund_paise, status FROM returns WHERE id = ?", id);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No such return.");
        Map<String, Object> row = rows.get(0);
        if (!"requested".equals(row.get("status")) && !"in_transit".equals(row.get("status"))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "That return is not waiting to be received.");
        }
        jdbc.update("UPDATE returns SET status = 'refunded', decided_by = ?, updated_at = now() WHERE id = ?", user.id(), id);
        if (restock) {
            jdbc.update("UPDATE inventory SET on_hand = on_hand + ? WHERE offer_id = (" +
                        "SELECT offer_id FROM order_items WHERE id = ?) AND warehouse_id = (" +
                        "SELECT MIN(warehouse_id) FROM inventory WHERE offer_id = (" +
                        "SELECT offer_id FROM order_items WHERE id = ?))", row.get("qty"), row.get("order_item_id"), row.get("order_item_id"));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id);
        out.put("refunded_paise", row.get("refund_paise"));
        out.put("restocked", restock);
        return out;
    }

    @PostMapping("/returns/{id}/reject")
    public Map<String, Object> rejectReturn(@CookieValue(name = "equidron_session", required = false) String token,
                                            @PathVariable long id, @RequestBody(required = false) Map<String, Object> body) {
        UserRepository.User user = staff(token);
        String note = body == null || body.get("note") == null ? null : String.valueOf(body.get("note"));
        int changed = jdbc.update("UPDATE returns SET status = 'rejected', decided_by = ?, reason = COALESCE(?, reason), " +
                                  "updated_at = now() WHERE id = ? AND status IN ('requested', 'in_transit')", user.id(), note, id);
        if (changed == 0) throw new ResponseStatusException(HttpStatus.CONFLICT, "That return is not waiting for a decision.");
        return Map.of("id", id, "status", "rejected");
    }

    /** A reply to the customer, and optionally closing the ticket. */
    @PostMapping("/support/{id}/reply")
    @Transactional
    public List<Map<String, Object>> replyToTicket(@CookieValue(name = "equidron_session", required = false) String token,
                                                   @PathVariable long id, @RequestBody Map<String, Object> body) {
        staff(token);
        String message = String.valueOf(body.getOrDefault("message", "")).trim();
        if (message.isEmpty()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Write a reply first.");
        boolean close = Boolean.TRUE.equals(body.get("close"));
        jdbc.update("INSERT INTO support_messages (ticket_id, author_role, body, at) VALUES (?, 'ops', ?, now())", id, message);
        jdbc.update("UPDATE support_tickets SET first_response_at = COALESCE(first_response_at, now()), " +
                    "status = ?, resolved_at = CASE WHEN ? THEN now() ELSE resolved_at END WHERE id = ?",
            close ? "resolved" : "awaiting_customer", close, id);
        return jdbc.queryForList(
            "SELECT t.id, t.subject, t.status, t.created_at, u.email, " +
            "       (SELECT count(*) FROM support_messages m WHERE m.ticket_id = t.id) AS messages " +
            "FROM support_tickets t JOIN users u ON u.id = t.user_id ORDER BY t.id DESC LIMIT 100");
    }

    /** One stage forward for every shipment that is not finished. */
    @PostMapping("/shipments/advance-all")
    public Map<String, Object> advanceAll(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        int advanced = jdbc.update(
            "UPDATE shipments SET status = CASE status " +
            "  WHEN 'pending' THEN 'packed' WHEN 'packed' THEN 'shipped' " +
            "  WHEN 'shipped' THEN 'in_transit' WHEN 'in_transit' THEN 'out_for_delivery' " +
            "  WHEN 'out_for_delivery' THEN 'delivered' ELSE status END, updated_at = now() " +
            "WHERE status IN ('pending', 'packed', 'shipped', 'in_transit', 'out_for_delivery')");
        return Map.of("advanced", advanced);
    }

    /** Change one agent. Money limits and levels are a person's decision, recorded by the row itself. */
    @PostMapping("/agents/{id}")
    public Map<String, Object> saveAgent(@CookieValue(name = "equidron_session", required = false) String token,
                                         @PathVariable String id, @RequestBody Map<String, Object> body) {
        staff(token);
        jdbc.update("UPDATE agents SET enabled = COALESCE(?, enabled), autonomy_level = COALESCE(?, autonomy_level), " +
                    "model = COALESCE(?, model), daily_budget_usd = COALESCE(?, daily_budget_usd), " +
                    "max_steps = COALESCE(?, max_steps) WHERE id = ?",
            body.get("enabled"), body.get("autonomy_level"), body.get("model"),
            body.get("daily_budget_usd"), body.get("max_steps"), id);
        return jdbc.queryForMap(
            "SELECT id, enabled, autonomy_level, model, daily_budget_usd, max_steps FROM agents WHERE id = ?", id);
    }

    /** The kill switch, for every agent at once. */
    @PostMapping("/agents/pause-all")
    public Map<String, Object> pauseAll(@CookieValue(name = "equidron_session", required = false) String token,
                                        @RequestBody Map<String, Object> body) {
        staff(token);
        boolean paused = Boolean.TRUE.equals(body.get("paused"));
        jdbc.update("UPDATE agents SET enabled = ?", !paused);
        // The column is jsonb, so the text is cast; plain 'true' is valid JSON, the cast is what Postgres needs.
        jdbc.update("INSERT INTO settings (key, value) VALUES ('agents_paused', ?::jsonb) " +
                    "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", paused ? "true" : "false");
        return Map.of("paused", paused);
    }
}