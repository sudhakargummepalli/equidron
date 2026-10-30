package in.equidron.seller;

import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import in.equidron.cart.SessionUser;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * The Seller Central panels: the seller's own orders, money, submissions and notices.
 *
 * Every query is scoped by the shop that belongs to the signed-in user, in the SQL, so a seller cannot
 * read another shop's orders by changing an id. A customer gets 403 rather than an empty page, because
 * an empty page would suggest a shop with nothing in it.
 */
@RestController
@RequestMapping("/api/seller")
public class SellerPanelsController {

    private final JdbcTemplate jdbc;
    private final SessionUser session;
    private final SessionService sessions;
    private final UserRepository users;
    private final SellerRepository sellers;

    public SellerPanelsController(JdbcTemplate jdbc, SessionUser session, SessionService sessions,
                                  UserRepository users, SellerRepository sellers) {
        this.jdbc = jdbc;
        this.session = session;
        this.sessions = sessions;
        this.users = users;
        this.sellers = sellers;
    }

    /** What the listing form needs: the categories and states the marketplace uses. */
    @GetMapping("/meta")
    public Map<String, Object> meta(@CookieValue(name = "equidron_session", required = false) String token) {
        session.require(token);
        return Map.of(
            "categories", jdbc.queryForList("SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category")
                              .stream().map(r -> r.get("category")).toList(),
            "conditions", List.of("new", "refurbished", "used"));
    }

    @GetMapping("/me")
    public Map<String, Object> me(@CookieValue(name = "equidron_session", required = false) String token) {
        long userId = session.require(token);
        UserRepository.User user = users.byId(userId);
        sellers.shopOf(userId);
        return Map.of("user", Map.of("id", user.id(), "email", user.email(), "name", user.name(), "role", user.role()),
                      "demo", "false");
    }

    @PostMapping("/logout")
    public Map<String, Object> logout(@CookieValue(name = "equidron_session", required = false) String token) {
        sessions.delete(token);
        return Map.of("ok", true);
    }

    @GetMapping("/notifications")
    public List<Map<String, Object>> notifications(@CookieValue(name = "equidron_session", required = false) String token) {
        return jdbc.queryForList(
            "SELECT id, message, link, is_read, at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50",
            session.require(token));
    }

    @PostMapping("/notifications/read")
    public Map<String, Object> read(@CookieValue(name = "equidron_session", required = false) String token) {
        jdbc.update("UPDATE notifications SET is_read = true WHERE user_id = ?", session.require(token));
        return Map.of("ok", true);
    }

    /** The seller's orders: the lines that belong to this shop, with their shipment state. */
    @GetMapping("/orders")
    public List<Map<String, Object>> orders(@CookieValue(name = "equidron_session", required = false) String token) {
        long shopId = sellers.shopOf(session.require(token));
        return jdbc.queryForList(
            "SELECT oi.order_id, oi.id AS order_item_id, oi.title, oi.qty, oi.unit_price_paise, " +
            "       oi.returned_qty, o.status, o.created_at, " +
            "       (SELECT s.id FROM shipments s WHERE s.order_id = oi.order_id ORDER BY s.id LIMIT 1) AS shipment_id, " +
            "       (SELECT s.status FROM shipments s WHERE s.order_id = oi.order_id ORDER BY s.id LIMIT 1) AS shipment_status " +
            "FROM order_items oi JOIN orders o ON o.id = oi.order_id " +
            "WHERE oi.seller_id = ? ORDER BY oi.id DESC LIMIT 100", shopId);
    }

    /** What this shop has earned, order line by order line, and what it has been paid. */
    @GetMapping("/ledger")
    public Map<String, Object> ledger(@CookieValue(name = "equidron_session", required = false) String token) {
        long shopId = sellers.shopOf(session.require(token));
        List<Map<String, Object>> lines = jdbc.queryForList(
            "SELECT oi.order_id, oi.title, oi.qty, oi.unit_price_paise, " +
            "       (oi.qty * oi.unit_price_paise) AS line_paise, o.created_at " +
            "FROM order_items oi JOIN orders o ON o.id = oi.order_id " +
            "WHERE oi.seller_id = ? ORDER BY oi.id DESC LIMIT 200", shopId);
        long earned = lines.stream().mapToLong(l -> ((Number) l.get("line_paise")).longValue()).sum();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("lines", lines);
        out.put("earned_paise", earned);
        out.put("paid_paise", jdbc.queryForObject(
            "SELECT COALESCE(SUM(l.net_paise), 0) FROM payout_lines l JOIN payout_batches b ON b.id = l.batch_id " +
            "WHERE l.seller_id = ? AND b.status = 'approved'", Long.class, shopId));
        return out;
    }

    /** Products already on the marketplace, so a seller can offer an existing one instead of retyping it. */
    @GetMapping("/catalog")
    public List<Map<String, Object>> catalog(@CookieValue(name = "equidron_session", required = false) String token,
                                             @RequestParam(name = "q", defaultValue = "") String q) {
        session.require(token);
        return jdbc.queryForList(
            "SELECT id, title, brand, category FROM products WHERE status = 'live' AND title ILIKE ? " +
            "ORDER BY title LIMIT 20", "%" + q.trim() + "%");
    }

    /** A listing submission, waiting for the review the Ops side performs. */
    @GetMapping("/submissions")
    public List<Map<String, Object>> submissions(@CookieValue(name = "equidron_session", required = false) String token) {
        long shopId = sellers.shopOf(session.require(token));
        return jdbc.queryForList(
            "SELECT id, kind, status, auto_decided, review_reasons, reviewer_note, created_at " +
            "FROM submissions WHERE seller_id = ? ORDER BY id DESC LIMIT 100", shopId);
    }

    @PostMapping("/submissions")
    public Map<String, Object> submit(@CookieValue(name = "equidron_session", required = false) String token,
                                      @RequestBody Map<String, Object> body) {
        long shopId = sellers.shopOf(session.require(token));
        Object productId = body.get("product_id");
        Object price = body.get("price_paise");
        if (price == null || ((Number) price).longValue() < 100) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "A price of at least one rupee is required.");
        }
        long pricePaise = ((Number) price).longValue();
        Long product = productId == null ? null : ((Number) productId).longValue();
        if (product == null) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Choose the product you are offering.");

        // A shop that has never dispatched has no warehouse yet; a seller cannot submit stock without one.
        Integer warehouses = jdbc.queryForObject(
            "SELECT count(*) FROM warehouses WHERE seller_id = ?", Integer.class, shopId);
        if (warehouses == null || warehouses == 0) {
            jdbc.update("INSERT INTO warehouses (code, name, city, kind, seller_id) " +
                        "VALUES (?, ?, ?, 'seller_dispatch', ?) ON CONFLICT (code) DO NOTHING",
                "S-" + shopId, "Dispatch " + shopId, "Bengaluru", shopId);
        }

        // The offer exists from the moment it is submitted, but not in the shop: "pending" is what the
        // marketplace does not show. A second submission for the same product updates that row rather than
        // failing on the unique key, which is what a seller retrying a form would otherwise hit.
        Long offerId = jdbc.queryForObject(
            "INSERT INTO offers (product_id, seller_id, price_paise, mrp_paise, condition, fulfilment, handling_days, status, updated_at) " +
            "VALUES (?, ?, ?, ?, 'new', 'seller', 1, 'pending', now()) " +
            "ON CONFLICT (product_id, seller_id, condition) DO UPDATE " +
            "SET price_paise = EXCLUDED.price_paise, status = 'pending', updated_at = now() RETURNING id",
            Long.class, product, shopId, pricePaise, Math.max(pricePaise, (long) (pricePaise * 1.2)));
        jdbc.update("INSERT INTO inventory (offer_id, warehouse_id, on_hand, reserved) " +
                    "SELECT ?, MIN(id), 10, 0 FROM warehouses WHERE seller_id = ? " +
                    "ON CONFLICT (offer_id, warehouse_id) DO UPDATE SET on_hand = 10", offerId, shopId);

        Long id = jdbc.queryForObject(
            "INSERT INTO submissions (seller_id, product_id, offer_id, kind, payload, status, review_reasons, created_at) " +
            "VALUES (?, ?, ?, 'new_offer', ?::jsonb, 'pending', '[]'::jsonb, now()) RETURNING id",
            Long.class, shopId, product, offerId, "{\"price_paise\":" + pricePaise + "}");
        return Map.of("id", id, "offer_id", offerId, "status", "pending");
    }

    /** Move one shipment to its next state. The order it belongs to keeps the history. */
    @PostMapping("/shipments/{id}/advance")
    public Map<String, Object> advance(@CookieValue(name = "equidron_session", required = false) String token,
                                       @PathVariable long id) {
        long shopId = sellers.shopOf(session.require(token));
        List<String> own = jdbc.queryForList(
            "SELECT s.status FROM shipments s JOIN order_items oi ON oi.order_id = s.order_id " +
            "WHERE s.id = ? AND oi.seller_id = ? LIMIT 1", String.class, id, shopId);
        if (own.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "That shipment is not yours.");
        String next = switch (own.get(0)) {
            case "pending" -> "packed";
            case "packed" -> "shipped";
            case "shipped" -> "delivered";
            default -> own.get(0);
        };
        jdbc.update("UPDATE shipments SET status = ?, updated_at = now() WHERE id = ?", next, id);
        return Map.of("id", id, "status", next);
    }
}