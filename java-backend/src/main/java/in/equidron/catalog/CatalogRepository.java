package in.equidron.catalog;

import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Search and product detail over the existing tables, including the delivery promise.
 *
 * A buyer is told, per offer, whether that seller ships to their city and when it would arrive - the
 * page refuses to offer a product it cannot deliver, so those fields are not decoration: without them
 * the shop looks unable to sell anything.
 */
@Repository
public class CatalogRepository {

    private final JdbcTemplate jdbc;

    public CatalogRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The cities a buyer can choose, taken from where sellers actually are. */
    public List<String> cities() {
        return jdbc.queryForList("SELECT DISTINCT city FROM sellers WHERE city IS NOT NULL ORDER BY city", String.class);
    }

    /** The categories the shop actually has, in alphabetical order: what the header lists. */
    public List<String> categories() {
        return jdbc.queryForList(
            "SELECT DISTINCT category FROM products WHERE status = 'live' AND category IS NOT NULL ORDER BY category", String.class);
    }

    public int countSearch(String q, String category) {
        String like = q == null || q.isBlank() ? "%" : "%" + q.trim() + "%";
        Integer total = jdbc.queryForObject(
            "SELECT count(DISTINCT p.id) FROM products p JOIN offers o ON o.product_id = p.id AND o.status = 'active' " +
            "WHERE p.status = 'live' AND (p.title ILIKE ? OR p.brand ILIKE ?) " +
            "AND (? = '' OR p.category = ?)", Integer.class, like, like,
            category == null ? "" : category, category == null ? "" : category);
        return total == null ? 0 : total;
    }

    public List<Map<String, Object>> search(String q, String category, int limit, int offset) {
        String like = q == null || q.isBlank() ? "%" : "%" + q.trim() + "%";
        return jdbc.queryForList(
            "SELECT p.id, p.title, p.brand, p.category, " +
            "       MIN(o.price_paise) AS price_paise, COUNT(o.id) AS offer_count, " +
            "       COALESCE(SUM((SELECT COALESCE(SUM(i.on_hand - i.reserved), 0) FROM inventory i WHERE i.offer_id = o.id)), 0) > 0 AS in_stock " +
            "FROM products p JOIN offers o ON o.product_id = p.id AND o.status = 'active' " +
            "WHERE p.status = 'live' AND (p.title ILIKE ? OR p.brand ILIKE ?) " +
            "AND (? = '' OR p.category = ?) " +
            "GROUP BY p.id, p.title, p.brand, p.category " +
            "ORDER BY MIN(o.price_paise), p.id LIMIT ? OFFSET ?",
            like, like, category == null ? "" : category, category == null ? "" : category,
            Math.min(50, Math.max(1, limit)), Math.max(0, offset));
    }

    public Map<String, Object> product(long id, String city) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT id, title, brand, category, description, specs, images, return_window_days, status, " +
            "       rating, review_count FROM products WHERE id = ? AND status = 'live'", id);
        if (rows.isEmpty()) return null;
        Map<String, Object> product = new java.util.LinkedHashMap<>(rows.get(0));

        List<Map<String, Object>> offers = jdbc.queryForList(
            "SELECT o.id, o.price_paise, o.mrp_paise, o.condition, o.fulfilment, o.handling_days, o.ships_to, " +
            "       s.name AS seller_name, s.rating AS seller_rating, s.rating_count AS seller_rating_count, " +
            "       s.city AS seller_city, " +
            "       COALESCE((SELECT SUM(i.on_hand - i.reserved) FROM inventory i WHERE i.offer_id = o.id), 0) AS available " +
            "FROM offers o JOIN sellers s ON s.id = o.seller_id " +
            "WHERE o.product_id = ? AND o.status = 'active' ORDER BY o.price_paise, o.id", id);

        boolean featured = false;
        for (Map<String, Object> offer : offers) {
            Object shipsToRaw = offer.get("ships_to");
            List<String> shipsTo = List.of();
            if (shipsToRaw instanceof String text) {
                shipsTo = java.util.Arrays.stream(text.replaceAll("[\\[\\]\"]", "").split(","))
                    .map(String::trim).filter(s -> !s.isEmpty()).toList();
            } else if (shipsToRaw instanceof java.util.List<?> list) {
                shipsTo = list.stream().map(String::valueOf).toList();
            }
            boolean deliverable = city == null || city.isBlank()
                || shipsTo.isEmpty() || shipsTo.stream().anyMatch(c -> c.equalsIgnoreCase(city));
            long available = ((Number) offer.get("available")).longValue();
            int days = ((Number) offer.get("handling_days")).intValue() + 2;
            offer.put("ships_to", shipsTo);
            offer.put("deliverable", deliverable);
            offer.put("eta", java.time.LocalDate.now().plusDays(days).toString());
            if (deliverable && available > 0) featured = true;
        }
        product.put("offers", offers);
        product.put("featured", featured);
        return product;
    }
}