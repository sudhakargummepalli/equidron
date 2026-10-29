package in.equidron.checkout;

import in.equidron.cart.SessionUser;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

/** POST /api/shop/orders with an Idempotency-Key header, as the Node server expects. */
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
                                     @RequestHeader(value = "Idempotency-Key", required = false) String key,
                                     @RequestBody Map<String, Object> body) {
        long userId = session.require(token);
        long addressId = ((Number) body.get("address_id")).longValue();
        String method = String.valueOf(body.getOrDefault("payment_method", "cod"));
        Map<String, Object> out = checkout.place(userId, addressId, method, key);
        return org.springframework.http.ResponseEntity.status(201).body(out);
    }
}