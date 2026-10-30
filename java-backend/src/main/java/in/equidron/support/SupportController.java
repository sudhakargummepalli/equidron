package in.equidron.support;

import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import in.equidron.cart.SessionUser;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * Customer support: a person opens a request, reads the answers, and can write again.
 *
 * A ticket belongs to the account that opened it and every read is scoped by that account in the SQL, so
 * a changed id is a 404 rather than somebody else's conversation. Staff reply through the Ops route,
 * which is the only place a reply is marked as coming from the marketplace.
 */
@RestController
@RequestMapping("/api/shop/support")
public class SupportController {

    private final JdbcTemplate jdbc;
    private final SessionUser session;

    public SupportController(JdbcTemplate jdbc, SessionUser session) {
        this.jdbc = jdbc;
        this.session = session;
    }

    private List<Map<String, Object>> ticketsFor(long userId) {
        List<Map<String, Object>> tickets = jdbc.queryForList(
            "SELECT id, subject, status, order_id, created_at, resolved_at FROM support_tickets " +
            "WHERE user_id = ? ORDER BY id DESC", userId);
        for (Map<String, Object> ticket : tickets) {
            ticket.put("messages", jdbc.queryForList(
                "SELECT author_role, body, at FROM support_messages WHERE ticket_id = ? ORDER BY id", ticket.get("id")));
        }
        return tickets;
    }

    @GetMapping
    public List<Map<String, Object>> list(@CookieValue(name = "equidron_session", required = false) String token) {
        return ticketsFor(session.require(token));
    }

    @PostMapping
    @Transactional
    public List<Map<String, Object>> open(@CookieValue(name = "equidron_session", required = false) String token,
                                          @RequestBody Map<String, Object> body) {
        long userId = session.require(token);
        String subject = String.valueOf(body.getOrDefault("subject", "")).trim();
        String message = String.valueOf(body.getOrDefault("message", "")).trim();
        if (subject.length() < 3) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Give your request a subject.");
        if (message.length() < 3) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Tell us what happened.");

        Object orderId = body.get("order_id");
        Long ticketId = jdbc.queryForObject(
            "INSERT INTO support_tickets (user_id, order_id, subject, status, created_at, first_response_due_at) " +
            "VALUES (?, ?, ?, 'open', now(), now() + interval '1 day') RETURNING id",
            Long.class, userId, orderId == null ? null : ((Number) orderId).longValue(), subject);
        jdbc.update("INSERT INTO support_messages (ticket_id, author_role, body, at) VALUES (?, 'customer', ?, now())",
            ticketId, message);
        return ticketsFor(userId);
    }

    /** Writing again reopens a resolved ticket: a customer with a follow-up is not a closed case. */
    @PostMapping("/{id}/reply")
    @Transactional
    public List<Map<String, Object>> reply(@CookieValue(name = "equidron_session", required = false) String token,
                                           @PathVariable long id, @RequestBody Map<String, Object> body) {
        long userId = session.require(token);
        String message = String.valueOf(body.getOrDefault("message", "")).trim();
        if (message.isEmpty()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Write a message first.");
        List<Map<String, Object>> own = jdbc.queryForList(
            "SELECT id FROM support_tickets WHERE id = ? AND user_id = ?", id, userId);
        if (own.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No such request.");
        jdbc.update("INSERT INTO support_messages (ticket_id, author_role, body, at) VALUES (?, 'customer', ?, now())", id, message);
        jdbc.update("UPDATE support_tickets SET status = 'open', resolved_at = NULL WHERE id = ?", id);
        return ticketsFor(userId);
    }
}