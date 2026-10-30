package in.equidron.integrations;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Payment capture.
 *
 * The amount is taken from the order, never from the request: a client that says "I paid 1 rupee"
 * must not be able to mark a 50,000 rupee order paid. The signature is verified when real keys are
 * configured; with no keys the gateway runs in simulated mode and says so in the audit fields.
 *
 * Capture is a guarded UPDATE on status = 'pending', so a duplicated webhook or a double click cannot
 * capture twice.
 */
@Service
public class PaymentGateway {

    private final JdbcTemplate jdbc;
    private final String keyId;
    private final String keySecret;

    public PaymentGateway(JdbcTemplate jdbc,
                          @Value("${RAZORPAY_KEY_ID:}") String keyId,
                          @Value("${RAZORPAY_KEY_SECRET:}") String keySecret) {
        this.jdbc = jdbc;
        this.keyId = keyId;
        this.keySecret = keySecret;
    }

    public boolean live() {
        return keyId != null && !keyId.isBlank() && keySecret != null && !keySecret.isBlank();
    }

    public String mode() {
        return live() ? Razorpay.mode(keyId) : "simulated";
    }

    /** The payment row for an order, with the amount the order says is due. */
    @Transactional
    public Map<String, Object> start(long orderId, long userId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT o.total_paise, o.payment_status, p.status AS payment_status_detail " +
            "FROM orders o LEFT JOIN payments p ON p.order_id = o.id " +
            "WHERE o.id = ? AND o.user_id = ? ORDER BY p.id DESC LIMIT 1", orderId, userId);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Order not found.");
        long amount = ((Number) rows.get(0).get("total_paise")).longValue();
        if (amount < 100) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The amount is below the payment minimum.");

        // One payment row per order at a time; a starting order reuses a pending one.
        Integer pending = jdbc.queryForObject("SELECT count(*) FROM payments WHERE order_id = ? AND status = 'pending'", Integer.class, orderId);
        if (pending == 0) {
            jdbc.update("INSERT INTO payments (order_id, method, instrument, status, authorized_paise, captured_paise, created_at, updated_at) " +
                        "VALUES (?, 'razorpay', 'Razorpay', 'pending', 0, 0, now(), now())", orderId);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("order_id", orderId);
        out.put("amount_paise", amount);
        out.put("mode", mode());
        out.put("live", live());
        return out;
    }

    /**
     * Mark paid. The signature is checked only when real keys exist; the amount always comes from the
     * order, and only a pending payment can be captured.
     */
    @Transactional
    public Map<String, Object> capture(long orderId, String paymentId, String signature) {
        List<Map<String, Object>> orders = jdbc.queryForList(
            "SELECT total_paise FROM orders WHERE id = ?", orderId);
        if (orders.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Order not found.");
        long amount = ((Number) orders.get(0).get("total_paise")).longValue();

        if (live() && !Razorpay.verifyPaymentSignature(orderId + "", paymentId, signature, keySecret)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The payment signature does not match.");
        }

        int changed = jdbc.update(
            "UPDATE payments SET status = 'captured', captured_paise = ?, provider_ref = ?, updated_at = now() " +
            "WHERE order_id = ? AND status = 'pending'", amount, paymentId == null ? "simulated-" + orderId : paymentId, orderId);
        if (changed == 0) throw new ResponseStatusException(HttpStatus.CONFLICT, "That payment was already captured.");

        jdbc.update("UPDATE orders SET payment_status = 'captured', status = 'confirmed', updated_at = now() WHERE id = ?", orderId);
        jdbc.update("INSERT INTO events (type, entity, entity_id, payload, created_at) VALUES ('payment.captured', 'order', ?, ?::jsonb, now())",
            orderId, "{\"amount_paise\":" + amount + ",\"mode\":\"" + mode() + "\"}");

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("order_id", orderId);
        out.put("captured_paise", amount);
        out.put("mode", mode());
        return out;
    }
}