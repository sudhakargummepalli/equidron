package in.equidron.ops;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * What staff need to see first: is the marketplace healthy, and where is the money going.
 *
 * Every number is a count or a sum over rows that already exist, so nothing here can be stale in a
 * way a refund or a failed job would not show up in.
 */
@Repository
public class OpsRepository {

    private final JdbcTemplate jdbc;

    public OpsRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Map<String, Object> overview() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("orders_today", jdbc.queryForObject(
            "SELECT count(*) FROM orders WHERE created_at >= date_trunc('day', now())", Integer.class));
        out.put("revenue_today_paise", jdbc.queryForObject(
            "SELECT COALESCE(SUM(total_paise), 0) FROM orders WHERE created_at >= date_trunc('day', now()) " +
            "AND status NOT IN ('cancelled', 'payment_failed')", Long.class));
        out.put("outbox_queued", jdbc.queryForObject(
            "SELECT count(*) FROM outbox WHERE status = 'queued'", Integer.class));
        out.put("outbox_failed", jdbc.queryForObject(
            "SELECT count(*) FROM outbox WHERE status = 'failed'", Integer.class));
        out.put("jobs_dead", jdbc.queryForObject(
            "SELECT count(*) FROM jobs WHERE status IN ('dead', 'failed')", Integer.class));
        out.put("payments_pending", jdbc.queryForObject(
            "SELECT count(*) FROM payments WHERE status = 'pending'", Integer.class));
        return out;
    }

    /** The sellers earning the most in the last 90 days, by what was actually paid. */
    public List<Map<String, Object>> topSellers(int days, int limit) {
        return jdbc.queryForList(
            "SELECT s.id AS seller_id, s.name, s.city, " +
            "       COUNT(DISTINCT o.id) AS orders, " +
            "       SUM(oi.qty) AS units, " +
            "       SUM(oi.qty * oi.unit_price_paise) AS revenue_paise " +
            "FROM order_items oi JOIN orders o ON o.id = oi.order_id " +
            "JOIN sellers s ON s.id = oi.seller_id " +
            "WHERE o.created_at >= now() - (? || ' days')::interval " +
            "  AND o.status NOT IN ('cancelled', 'payment_failed') " +
            "GROUP BY s.id, s.name, s.city " +
            "ORDER BY revenue_paise DESC LIMIT ?",
            String.valueOf(days), Math.min(50, Math.max(1, limit)));
    }

    /** Orders whose payment never completed and are older than a quarter of an hour. */
    public List<Map<String, Object>> stuckPayments() {
        return jdbc.queryForList(
            "SELECT o.id AS order_id, o.payment_method, o.total_paise, o.created_at " +
            "FROM orders o JOIN payments p ON p.order_id = o.id " +
            "WHERE p.status = 'pending' AND o.created_at < now() - interval '15 minutes' " +
            "ORDER BY o.created_at LIMIT 50");
    }
}
