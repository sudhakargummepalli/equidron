package in.equidron.checkout;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Reading an order back the way the page shows it: shipments, and inside each one the items that can
 * still be returned.
 *
 * "Returnable" is a fact about dates and quantities, not a wish: an item is returnable while the window
 * is open, the shipment is delivered and some quantity has not already been returned. The page draws the
 * Return button from those three together, so they are computed here rather than in the template.
 */
@Repository
public class OrderRepository {

    public static final int RETURN_WINDOW_DAYS = 10;

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

        Map<String, Object> payment = jdbc.queryForMap(
            "SELECT method, instrument, status, authorized_paise, captured_paise, refunded_paise " +
            "FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1", orderId);
        order.put("payment", payment);

        List<Map<String, Object>> shipments = jdbc.queryForList(
            "SELECT id, status, carrier, tracking_no, eta, amount_paise FROM shipments WHERE order_id = ? ORDER BY id", orderId);
        // Orders restored from an older snapshot have no shipment rows; the order's own status is then the
        // only evidence of whether the parcel arrived, and it is what a return decision should trust.
        if (shipments.isEmpty()) {
            String status = String.valueOf(order.get("status"));
            shipments = List.of(Map.of("id", 0, "status", "delivered".equals(status) ? "delivered" : "pending"));
        }

        List<Map<String, Object>> items = jdbc.queryForList(
            "SELECT id, product_id, title, qty, unit_price_paise, returned_qty FROM order_items WHERE order_id = ? ORDER BY id", orderId);

        List<Map<String, Object>> shaped = new ArrayList<>();
        for (Map<String, Object> shipment : shipments) {
            Map<String, Object> s = new LinkedHashMap<>(shipment);
            List<Map<String, Object>> its = new ArrayList<>();
            for (Map<String, Object> item : items) {
                Map<String, Object> i = new LinkedHashMap<>(item);
                int qty = ((Number) item.get("qty")).intValue();
                int returned = item.get("returned_qty") == null ? 0 : ((Number) item.get("returned_qty")).intValue();
                int left = Math.max(0, qty - returned);
                boolean delivered = "delivered".equals(shipment.get("status"));
                Integer ageDays = jdbc.queryForObject(
                    "SELECT EXTRACT(DAY FROM now() - created_at)::int FROM orders WHERE id = ?", Integer.class, orderId);
                boolean inWindow = ageDays != null && ageDays <= RETURN_WINDOW_DAYS;
                boolean returnable = delivered && left > 0 && inWindow;
                i.put("returned_qty", returned);
                i.put("returnable_qty", left);
                i.put("returnable", returnable);
                i.put("return_note", returnable ? "Returnable for " + Math.max(0, RETURN_WINDOW_DAYS - (ageDays == null ? 0 : ageDays)) + " more days"
                    : (returned > 0 && left == 0 ? "Fully returned" : (!inWindow ? "The return window has closed" : "Not delivered yet")));
                its.add(i);
            }
            s.put("items", its);
            shaped.add(s);
        }
        order.put("shipments", shaped);
        order.put("items", items);
        return order;
    }

    /** Record a return request; the quantity stays with the item so the page can show what is left. */
    public Map<String, Object> requestReturn(long userId, long orderId, long itemId, int qty, String reason) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT i.id, i.qty, i.returned_qty, i.unit_price_paise FROM order_items i " +
            "JOIN orders o ON o.id = i.order_id WHERE i.id = ? AND o.id = ? AND o.user_id = ?",
            itemId, orderId, userId);
        if (rows.isEmpty()) return null;
        Map<String, Object> item = rows.get(0);
        int ordered = ((Number) item.get("qty")).intValue();
        int already = item.get("returned_qty") == null ? 0 : ((Number) item.get("returned_qty")).intValue();
        int wanted = Math.max(1, Math.min(qty, ordered - already));
        long refund = ((Number) item.get("unit_price_paise")).longValue() * wanted;

        jdbc.update("INSERT INTO returns (order_id, order_item_id, user_id, qty, reason, status, refund_paise, created_at, updated_at) " +
                    "VALUES (?, ?, ?, ?, ?, 'requested', ?, now(), now())",
            orderId, itemId, userId, wanted, reason == null ? "Not stated" : reason, refund);
        jdbc.update("UPDATE order_items SET returned_qty = COALESCE(returned_qty, 0) + ? WHERE id = ?", wanted, itemId);
        return one(userId, orderId);
    }
}