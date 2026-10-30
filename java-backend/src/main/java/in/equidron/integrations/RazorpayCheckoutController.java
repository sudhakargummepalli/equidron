package in.equidron.integrations;

import in.equidron.cart.SessionUser;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * The three routes the checkout modal calls: the key, a gateway order, and verification.
 *
 * With no keys the key route answers enabled:false and the page hides the button - which is better than
 * offering a payment that cannot be taken. The amount always comes from the order row, never from the
 * request, so a tampered page cannot pay one rupee for a phone.
 */
@RestController
@RequestMapping("/api/shop/payments/razorpay")
public class RazorpayCheckoutController {

    private final JdbcTemplate jdbc;
    private final SessionUser session;
    private final PaymentGateway payments;
    private final String keyId;
    private final String keySecret;

    public RazorpayCheckoutController(JdbcTemplate jdbc, SessionUser session, PaymentGateway payments,
                                      @Value("${RAZORPAY_KEY_ID:}") String keyId,
                                      @Value("${RAZORPAY_KEY_SECRET:}") String keySecret) {
        this.jdbc = jdbc;
        this.session = session;
        this.payments = payments;
        this.keyId = keyId;
        this.keySecret = keySecret;
    }

    private boolean configured() {
        return keyId != null && !keyId.isBlank() && keySecret != null && !keySecret.isBlank();
    }

    @GetMapping("/key")
    public Map<String, Object> key() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enabled", configured());
        if (configured()) {
            out.put("key_id", keyId);
            out.put("mode", Razorpay.mode(keyId));
        }
        return out;
    }

    /** Create the gateway order for an order this person owns, and remember it on the payment row. */
    @PostMapping("/order")
    public Map<String, Object> order(@CookieValue(name = "equidron_session", required = false) String token,
                                     @RequestBody Map<String, Object> body) {
        long userId = session.require(token);
        long orderId = ((Number) body.get("order_id")).longValue();
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT total_paise FROM orders WHERE id = ? AND user_id = ?", orderId, userId);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Order not found.");
        long amount = ((Number) rows.get(0).get("total_paise")).longValue();

        RazorpayOrders.Provider provider = RazorpayOrders.provider(configured(), keyId, keySecret);
        RazorpayOrders.CreatedOrder created = provider.create(amount, "order-" + orderId);
        jdbc.update("UPDATE payments SET provider_ref = ?, updated_at = now() " +
                    "WHERE order_id = ? AND status = 'pending'", created.id(), orderId);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("order_id", created.id());
        out.put("amount", created.amountPaise());
        out.put("currency", "INR");
        out.put("key_id", keyId);
        out.put("mode", created.mode());
        return out;
    }

    /** A payment is trusted only when the signature over order|payment checks out with the key secret. */
    @PostMapping("/verify")
    public Map<String, Object> verify(@CookieValue(name = "equidron_session", required = false) String token,
                                      @RequestBody Map<String, Object> body) {
        session.require(token);
        long orderId = ((Number) body.get("order_id")).longValue();
        String gatewayOrder = String.valueOf(body.get("razorpay_order_id"));
        String paymentId = String.valueOf(body.get("razorpay_payment_id"));
        String signature = String.valueOf(body.get("razorpay_signature"));

        if (configured() && !Razorpay.verifyPaymentSignature(gatewayOrder, paymentId, signature, keySecret)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The payment signature does not match.");
        }
        return payments.capture(orderId, paymentId, signature);
    }
}