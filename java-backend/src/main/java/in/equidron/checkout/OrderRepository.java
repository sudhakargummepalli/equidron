package in.equidron.checkout;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Reading back what checkout wrote: the order list and one order with its lines. */
@Repository
public class OrderRepository {

    private final JdbcTemplate jdbc;

    public OrderRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<Map<String, Object>> list(long userId) {
        return jdbc.queryForList(
            "SELECT id, status, payment_status, fulfilment_status, payment_method, " +
            "       subtotal_paise, shipping_paise, total_paise, created_at " +
            "FROM orders WHERE user_id = ? ORDER BY id DESC", userId);
    }

    public Map<String, Object> one(long userId, long orderId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT id, status, payment_status, fulfilment_status, payment_method, " +
            "       subtotal_paise, shipping_paise, total_paise, address, created_at " +
            "FROM orders WHERE id = ? AND user_id = ?", orderId, userId);
        if (rows.isEmpty()) return null;
        Map<String, Object> order = new LinkedHashMap<>(rows.get(0));
        order.put("items", jdbc.queryForList(
            "SELECT title, qty, unit_price_paise, returned_qty FROM order_items WHERE order_id = ? ORDER BY id", orderId));
        order.put("shipments", jdbc.queryForList(
            "SELECT id, status, eta, tracking_no, awb FROM shipments WHERE order_id = ? ORDER BY id", orderId));
        return order;
    }
}