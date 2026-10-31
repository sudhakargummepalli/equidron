package in.equidron.checkout;

import in.equidron.cart.SessionUser;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

/**
 * POST /api/shop/orders.
 *
 * The idempotency key arrives in a header or in the body; the Razorpay path sends a fingerprint of the
 * reviewed cart instead, and that is a better key than a random one because it is the same for the same
 * cart. The response carries the order id at the top level and inside "order", because the two pages
 * read it differently.
 */
@RestController
@RequestMapping("/api/shop")
public class CheckoutController {

    private final CheckoutService checkout;
    private final SessionUser session;

    public CheckoutController(CheckoutService checkout, SessionUser session) {
        this.checkout = checkout;
        this.session = session;
    }

    @PostMapping("/orders")
    public org.springframework.http.ResponseEntity<Map<String, Object>> place(@CookieValue(name = "equidron_session", required = false) String token,
                                     @RequestHeader(value = "Idempotency-Key", required = false) String headerKey,
                                     @RequestBody Map<String, Object> body) {
        long userId = session.require(token);
        long addressId = ((Number) body.get("address_id")).longValue();
        String method = String.valueOf(body.getOrDefault("payment_method", "cod"));

        String key = headerKey;
        if (key == null || key.isBlank()) key = text(body.get("idempotency_key"));
        if ((key == null || key.isBlank()) && body.get("fingerprint") != null) {
            // The reviewed cart is the key: the same review cannot place two orders.
            key = "co-" + userId + "-" + body.get("fingerprint");
        }

        Map<String, Object> placed = checkout.place(userId, addressId, method, key);
        Map<String, Object> order = new LinkedHashMap<>();
        order.put("id", placed.get("order_id"));
        order.put("order_id", placed.get("order_id"));
        order.put("total_paise", placed.get("total_paise"));
        order.put("status", "payment_pending");
        order.put("replayed", placed.get("replayed"));

        Map<String, Object> out = new LinkedHashMap<>(order);
        out.put("order", order);
        return org.springframework.http.ResponseEntity.status(
            Boolean.TRUE.equals(placed.get("replayed")) ? org.springframework.http.HttpStatus.OK
                                                         : org.springframework.http.HttpStatus.CREATED).body(out);
    }

    private static String text(Object value) {
        return value == null ? null : String.valueOf(value);
    }
}