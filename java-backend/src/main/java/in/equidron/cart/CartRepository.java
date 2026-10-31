package in.equidron.cart;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * The cart, over the existing cart_items table (user_id, offer_id, qty).
 *
 * The totals are computed here rather than by the database, because the checkout will need the same
 * arithmetic and one implementation cannot disagree with itself. Money stays in integer paise.
 */
@Repository
public class CartRepository {

    private final JdbcTemplate jdbc;

    public CartRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Map<String, Object> view(long userId) {
        List<Map<String, Object>> items = jdbc.queryForList(
            "SELECT c.offer_id, c.qty, c.price_at_add_paise, o.price_paise, o.condition, p.id AS product_id, p.title, " +
            "       p.images->>0 AS image, " +
            "       s.name AS seller_name, s.city AS seller_city, o.status, " +
            "       COALESCE((SELECT SUM(i.on_hand - i.reserved) FROM inventory i WHERE i.offer_id = o.id), 0) AS available " +
            "FROM cart_items c " +
            "JOIN offers o ON o.id = c.offer_id " +
            "JOIN products p ON p.id = o.product_id " +
            "JOIN sellers s ON s.id = o.seller_id " +
            "WHERE c.user_id = ? ORDER BY c.offer_id", userId);

        long subtotal = 0;
        int count = 0;
        for (Map<String, Object> row : items) {
            long price = ((Number) row.get("price_paise")).longValue();
            int qty = ((Number) row.get("qty")).intValue();
            long line = price * qty;
            row.put("line_paise", line);
            row.put("buyable", "active".equals(row.get("status")) && ((Number) row.get("available")).longValue() >= qty);
            subtotal += line;
            count += qty;
        }

        long shipping = count == 0 || subtotal >= 49900 ? 0 : 4000;
        Map<String, Object> estimate = new LinkedHashMap<>();
        estimate.put("subtotal_paise", subtotal);
        estimate.put("shipping_paise", shipping);
        estimate.put("total_paise", subtotal + shipping);
        estimate.put("free_shipping_from_paise", 49900);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", items);
        out.put("count", count);
        out.put("subtotal_paise", subtotal);
        out.put("estimate", estimate);
        return out;
    }

    /** Add, or increase the quantity if the offer is already there. One row per user and offer. */
    public void add(long userId, long offerId, int qty) {
        jdbc.update(
            "INSERT INTO cart_items (user_id, offer_id, qty, price_at_add_paise, added_at) " +
            "SELECT ?, o.id, ?, o.price_paise, now() FROM offers o WHERE o.id = ? " +
            "ON CONFLICT (user_id, offer_id) DO UPDATE SET qty = cart_items.qty + EXCLUDED.qty",
            userId, qty, offerId);
    }

    /** Set an exact quantity; zero removes the row. */
    public void setQty(long userId, long offerId, int qty) {
        if (qty <= 0) {
            jdbc.update("DELETE FROM cart_items WHERE user_id = ? AND offer_id = ?", userId, offerId);
            return;
        }
        jdbc.update("UPDATE cart_items SET qty = ? WHERE user_id = ? AND offer_id = ?", qty, userId, offerId);
    }

    public void remove(long userId, long offerId) {
        jdbc.update("DELETE FROM cart_items WHERE user_id = ? AND offer_id = ?", userId, offerId);
    }
}