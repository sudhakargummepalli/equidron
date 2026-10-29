package in.equidron.seller;

import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.web.server.ResponseStatusException;

/**
 * The seller's own listings: what they sell, at what price, with how much stock is left.
 *
 * Every query is scoped by the seller id that belongs to the signed-in user, so a seller can never
 * read or change another shop's rows - the scoping is in the SQL, not in a check the caller could
 * forget.
 */
@Repository
public class SellerRepository {

    private final JdbcTemplate jdbc;

    public SellerRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The shop id for a user, or a 403: a customer has no business on the seller endpoints. */
    public long shopOf(long userId) {
        List<Long> ids = jdbc.queryForList("SELECT id FROM sellers WHERE user_id = ?", Long.class, userId);
        if (ids.isEmpty()) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "This account is not a seller.");
        return ids.get(0);
    }

    public List<Map<String, Object>> listings(long shopId) {
        return jdbc.queryForList(
            "SELECT o.id AS offer_id, p.id AS product_id, p.title, p.brand, p.category, " +
            "       o.price_paise, o.mrp_paise, o.condition, o.status, o.handling_days, " +
            "       COALESCE(SUM(i.on_hand - i.reserved), 0) AS available, " +
            "       o.price_floor_paise, o.price_ceiling_paise " +
            "FROM offers o JOIN products p ON p.id = o.product_id " +
            "LEFT JOIN inventory i ON i.offer_id = o.id " +
            "WHERE o.seller_id = ? " +
            "GROUP BY o.id, p.id, p.title, p.brand, p.category, o.price_paise, o.mrp_paise, o.condition, " +
            "         o.status, o.handling_days, o.price_floor_paise, o.price_ceiling_paise " +
            "ORDER BY p.title", shopId);
    }

    public Map<String, Object> dashboard(long shopId) {
        return Map.of(
            "active_listings", jdbc.queryForObject(
                "SELECT count(*) FROM offers WHERE seller_id = ? AND status = 'active'", Integer.class, shopId),
            "open_order_lines", jdbc.queryForObject(
                "SELECT count(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id " +
                "WHERE oi.seller_id = ? AND o.status NOT IN ('delivered', 'cancelled', 'completed')", Integer.class, shopId),
            "low_stock", jdbc.queryForObject(
                "SELECT count(*) FROM offers o WHERE o.seller_id = ? AND o.status = 'active' AND " +
                "COALESCE((SELECT SUM(i.on_hand - i.reserved) FROM inventory i WHERE i.offer_id = o.id), 0) < 5",
                Integer.class, shopId));
    }

    /**
     * Change the price and the stock of one of this seller's offers. The price must sit inside the
     * band the seller themselves set (or none), which is the same rule the Node listing editor holds.
     */
    public Map<String, Object> update(long shopId, long offerId, Long pricePaise, Integer qty) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT price_floor_paise, price_ceiling_paise FROM offers WHERE id = ? AND seller_id = ?", offerId, shopId);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "That listing is not yours.");
        Map<String, Object> band = rows.get(0);

        if (pricePaise != null) {
            long floor = band.get("price_floor_paise") == null ? 100L : ((Number) band.get("price_floor_paise")).longValue();
            Long ceiling = band.get("price_ceiling_paise") == null ? null : ((Number) band.get("price_ceiling_paise")).longValue();
            if (pricePaise < floor || (ceiling != null && pricePaise > ceiling)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "That price is outside the band you set for this listing.");
            }
            jdbc.update("UPDATE offers SET price_paise = ?, updated_at = now() WHERE id = ? AND seller_id = ?",
                pricePaise, offerId, shopId);
        }
        if (qty != null) {
            if (qty < 0) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Stock cannot be negative.");
            jdbc.update("UPDATE inventory SET on_hand = reserved + ? WHERE offer_id = ? AND warehouse_id = (" +
                        "SELECT MIN(warehouse_id) FROM inventory WHERE offer_id = ?)", qty, offerId, offerId);
        }
        return Map.of("offer_id", offerId, "updated", true);
    }
}