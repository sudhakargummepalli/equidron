package in.equidron.mail;

import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Turns the events table into emails, exactly once.
 *
 * The event is marked dispatched only after the send succeeds, so a failed send is retried rather than
 * lost. A row already dispatched is never sent again, because a customer receiving two confirmations
 * for one order reads it as two orders.
 *
 * The send function is passed in, so the loop is testable without a mail server.
 */
@Service
public class EmailDispatcher {

    private static final List<String> KINDS = List.of("order.placed", "payment.captured");

    private final JdbcTemplate jdbc;

    public EmailDispatcher(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record Pending(long eventId, String type, long orderId) {}

    public List<Pending> pending(int limit) {
        return jdbc.query(
            "SELECT e.id, e.type, e.entity_id FROM events e JOIN orders o ON o.id = e.entity_id " +
            "WHERE e.type = ANY(?) AND e.entity = 'order' AND e.dispatched_at IS NULL ORDER BY e.id LIMIT ?",
            (rs, index) -> new Pending(rs.getLong("id"), rs.getString("type"), rs.getLong("entity_id")),
            KINDS.toArray(new String[0]), Math.min(50, Math.max(1, limit)));
    }

    /** Send what is waiting. Returns how many were sent; a failure stops the pass and is retried later. */
    public int drain(Consumer<Pending> send) {
        int sent = 0;
        for (Pending event : pending(20)) {
            send.accept(event);
            jdbc.update("UPDATE events SET dispatched_at = now() WHERE id = ? AND dispatched_at IS NULL", event.eventId());
            sent++;
        }
        return sent;
    }

    /** The recipient and the order figures for one event, or null if the order has gone. */
    public Map<String, Object> details(long orderId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT o.id, o.total_paise, o.payment_method, u.email, u.name " +
            "FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?", orderId);
        return rows.isEmpty() ? null : rows.get(0);
    }
}