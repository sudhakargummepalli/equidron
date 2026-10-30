package in.equidron.integrations;

import com.fasterxml.jackson.databind.JsonNode;
import in.equidron.agents.IdempotencyStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * The payment webhook.
 *
 * Three rules, in this order:
 *   1. The signature is checked over the RAW body before anything is parsed. A webhook that cannot be
 *      verified is 400 and does nothing.
 *   2. The body is parsed only after that.
 *   3. Capture is idempotent: the second delivery of the same event is a 200 with no change, because
 *      Razorpay retries and a retry is not a second payment.
 */
@RestController
@RequestMapping("/api/webhooks")
public class PaymentWebhookController {

    private final PaymentGateway gateway;
    private final IdempotencyStore claims;
    private final JdbcTemplate jdbc;
    private final String webhookSecret;
    private final ObjectMapper json = new ObjectMapper();

    public PaymentWebhookController(PaymentGateway gateway, IdempotencyStore claims, JdbcTemplate jdbc,
                                    @Value("${RAZORPAY_WEBHOOK_SECRET:}") String webhookSecret) {
        this.gateway = gateway;
        this.claims = claims;
        this.jdbc = jdbc;
        this.webhookSecret = webhookSecret;
    }

    @PostMapping("/payments")
    public ResponseEntity<Map<String, Object>> payments(
            @RequestHeader(value = "X-Razorpay-Signature", required = false) String signature,
            @RequestHeader(value = "X-Razorpay-Event-Id", required = false) String eventId,
            @RequestBody String rawBody) {
        boolean configured = webhookSecret != null && !webhookSecret.isBlank();
        if (configured && !Razorpay.verifyWebhook(rawBody, signature, webhookSecret)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The webhook signature does not match.");
        }
        try {
            JsonNode root = json.readTree(rawBody);
            String event = root.path("event").asText("");
            if (!event.startsWith("payment.captured") && !event.startsWith("order.paid")) {
                return ResponseEntity.ok(Map.of("ok", true, "ignored", event));
            }
            JsonNode entity = root.path("payload").path("payment").path("entity");
            long orderId = Long.parseLong(entity.path("notes").path("order_id").asText(
                entity.path("order_id").asText("0")).replaceAll("[^0-9]", ""));
            String paymentId = entity.path("id").asText(null);
            if (orderId == 0) return ResponseEntity.ok(Map.of("ok", true, "ignored", "no order id"));

            // Idempotent by the provider event id, so the same delivery is applied at most once.
            Long owner = jdbc.queryForObject("SELECT user_id FROM orders WHERE id = ?", Long.class, orderId);
            if (eventId != null && !eventId.isBlank()) {
                if (!claims.claim(owner, "webhook:" + eventId, "webhook:payments")) {
                    return ResponseEntity.ok(Map.of("ok", true, "replayed", true));
                }
            }
            try {
                gateway.capture(orderId, paymentId, configured ? signature : null);
            } catch (ResponseStatusException e) {
                // A retry of an event already applied is a success, not an error.
                if (e.getStatusCode().value() != 409) throw e;
            }
            if (eventId != null && !eventId.isBlank()) {
                claims.remember(owner, "webhook:" + eventId, 200, "{\"applied\":true}");
            }
            return ResponseEntity.ok(Map.of("ok", true));
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The webhook body could not be read.");
        }
    }
}