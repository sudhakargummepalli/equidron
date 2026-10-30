package in.equidron.checkout;

import in.equidron.auth.SessionService;
import in.equidron.cart.CartRepository;
import in.equidron.cart.SessionUser;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

/**
 * The review step before placing an order.
 *
 * Prices, stock and delivery are checked again here, because a cart can sit for hours. The answer names
 * what changed rather than silently repricing: a customer who agreed to one total must be told when it
 * is no longer that total.
 */
@RestController
@RequestMapping("/api/shop")
public class CheckoutPreviewController {

    private final JdbcTemplate jdbc;
    private final SessionUser session;
    private final CartRepository cart;
    private final SessionService sessions;

    public CheckoutPreviewController(JdbcTemplate jdbc, SessionUser session, CartRepository cart, SessionService sessions) {
        this.jdbc = jdbc;
        this.session = session;
        this.cart = cart;
        this.sessions = sessions;
    }

    @PostMapping("/checkout/preview")
    public Map<String, Object> preview(@CookieValue(name = "equidron_session", required = false) String token,
                                       @RequestBody(required = false) Map<String, Object> body) {
        long userId = session.require(token);
        Map<String, Object> view = cart.view(userId);
        List<Map<String, Object>> items = (List<Map<String, Object>>) view.get("items");

        List<Map<String, Object>> issues = new ArrayList<>();
        long subtotal = 0;
        for (Map<String, Object> item : items) {
            long offerId = ((Number) item.get("offer_id")).longValue();
            int qty = ((Number) item.get("qty")).intValue();
            Integer stock = jdbc.queryForObject(
                "SELECT COALESCE(SUM(on_hand - reserved), 0) FROM inventory WHERE offer_id = ?", Integer.class, offerId);
            Integer price = jdbc.queryForObject("SELECT price_paise FROM offers WHERE id = ?", Integer.class, offerId);
            // The price the customer saw when they added it, not the one the offer has now.
            Integer paid = ((Number) item.get("price_at_add_paise")).intValue();
            if (stock == null || stock < qty) {
                issues.add(Map.of("offer_id", offerId, "issue", "stock",
                    "message", "Only " + (stock == null ? 0 : stock) + " left of " + item.get("title") + "."));
            }
            // Compare the numbers, not the objects: two Integers above 127 are never the same reference.
            if (price != null && price.intValue() != paid.intValue()) {
                issues.add(Map.of("offer_id", offerId, "issue", "price",
                    "message", "The price of " + item.get("title") + " changed."));
            }
            long line = (price == null ? paid : price) * (long) qty;
            item.put("current_price_paise", price == null ? paid : price);
            item.put("current_line_paise", line);
            subtotal += line;
        }

        // The page reads these under the name totals, and each line needs the delivery date it prints.
        for (Map<String, Object> item : items) {
            long offerId = ((Number) item.get("offer_id")).longValue();
            Integer handling = jdbc.queryForObject("SELECT handling_days FROM offers WHERE id = ?", Integer.class, offerId);
            item.put("eta", java.time.LocalDate.now().plusDays((handling == null ? 1 : handling) + 2).toString());
        }
        long shipping = items.isEmpty() || subtotal >= 49900 ? 0 : 4000;
        Map<String, Object> totals = new LinkedHashMap<>();
        totals.put("subtotal_paise", subtotal);
        totals.put("shipping_paise", shipping);
        totals.put("total_paise", subtotal + shipping);
        totals.put("free_shipping_from_paise", 49900);
        Map<String, Object> estimate = new LinkedHashMap<>(totals);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", items);
        out.put("estimate", estimate);
        out.put("totals", totals);
        // What the cart looked like when the customer reviewed it; the order is placed against this.
        out.put("fingerprint", String.join(",", items.stream()
            .map(i -> i.get("offer_id") + "x" + i.get("qty") + "@" + i.get("current_price_paise")).toList()));
        out.put("issues", issues);
        // The page guards the pay button on preview.ok; can_place is the same fact under the name I chose.
        boolean ok = !items.isEmpty() && issues.isEmpty();
        out.put("ok", ok);
        out.put("can_place", ok);
        return out;
    }

    @PostMapping("/logout-all")
    public Map<String, Object> logoutAll(@CookieValue(name = "equidron_session", required = false) String token) {
        long userId = session.require(token);
        jdbc.update("DELETE FROM sessions WHERE user_id = ?", userId);
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
}