package in.equidron.catalog;

import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Search and product detail over the existing tables. The shape of the JSON is what the AngularJS
 * pages already read, so the same browser code works against either server.
 */
@Repository
public class CatalogRepository {

    private final JdbcTemplate jdbc;

    public CatalogRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<Map<String, Object>> search(String q, int limit) {
        String like = q == null || q.isBlank() ? "%" : "%" + q.trim() + "%";
        return jdbc.queryForList(
            "SELECT p.id, p.title, p.brand, p.category, " +
            "       MIN(o.price_paise) AS price_paise, COUNT(o.id) AS offer_count " +
            "FROM products p JOIN offers o ON o.product_id = p.id AND o.status = 'active' " +
            "WHERE p.status = 'live' AND (p.title ILIKE ? OR p.brand ILIKE ?) " +
            "GROUP BY p.id, p.title, p.brand, p.category " +
            "ORDER BY MIN(o.price_paise), p.id LIMIT ?",
            like, like, Math.min(50, Math.max(1, limit)));
    }

    public Map<String, Object> product(long id) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT id, title, brand, category, description, specs, images, " +
            "       return_window_days, status FROM products WHERE id = ? AND status = 'live'", id);
        if (rows.isEmpty()) return null;
        Map<String, Object> product = new java.util.LinkedHashMap<>(rows.get(0));
        product.put("offers", jdbc.queryForList(
            "SELECT o.id, o.price_paise, o.mrp_paise, o.condition, o.fulfilment, o.handling_days, " +
            "       s.name AS seller_name, s.rating AS seller_rating, s.rating_count AS seller_rating_count, " +
            "       s.city AS seller_city, " +
            "       COALESCE(SUM(i.on_hand - i.reserved), 0) AS available " +
            "FROM offers o JOIN sellers s ON s.id = o.seller_id " +
            "LEFT JOIN inventory i ON i.offer_id = o.id " +
            "WHERE o.product_id = ? AND o.status = 'active' " +
            "GROUP BY o.id, o.price_paise, o.mrp_paise, o.condition, o.fulfilment, o.handling_days, " +
            "         s.name, s.rating, s.rating_count, s.city " +
            "ORDER BY o.price_paise, o.id", id));
        return product;
    }
}