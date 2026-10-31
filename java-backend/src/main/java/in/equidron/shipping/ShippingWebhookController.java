package in.equidron.shipping;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import in.equidron.agents.Mask;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * What the carrier tells us, and what we do about it.
 *
 * The carrier is outside the building, so this endpoint is public - which means three things must hold
 * before a single row changes:
 *
 *  - The request is signed. HMAC-SHA256 over the raw body with the shared secret; no signature, no work.
 *  - The event is processed once. Carriers retry, and a retried "delivered" must not restock twice, so the
 *    event id is remembered on the shipment's own history.
 *  - The transition is allowed. A carrier cannot walk a delivered parcel back to pending, and cannot invent
 *    a state we do not know; the transition table decides, not the payload.
 *
 * When there is no secret configured the endpoint refuses everything and says so: an unsigned webhook that
 * is accepted "just for testing" is exactly how a demo becomes a way to mark parcels delivered.
 */
@RestController
public class ShippingWebhookController {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final JdbcTemplate jdbc;
    private final String secret;

    public ShippingWebhookController(JdbcTemplate jdbc,
                                     @Value("${SHIPPING_WEBHOOK_SECRET:}") String secret) {
        this.jdbc = jdbc;
        this.secret = secret == null ? "" : secret;
    }

    @PostMapping("/api/shipping/webhook")
    public Map<String, Object> webhook(@RequestHeader(name = "X-Equidron-Signature", required = false) String signature,
                                       @RequestBody String raw) {
        if (secret.isBlank()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "No shipping webhook secret is configured, so unsigned events are refused.");
        }
        if (signature == null || !constantTimeEquals(signature, hmac(raw))) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "The signature does not match.");
        }

        JsonNode event;
        try {
            event = JSON.readTree(raw);
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The event is not JSON.");
        }

        String eventId = event.path("event_id").asText("");
        String awb = event.path("awb").asText("");
        String status = event.path("status").asText("");
        String note = event.path("note").asText("");
        if (eventId.isBlank() || awb.isBlank() || status.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "event_id, awb and status are required.");
        }
        if (!ShipmentStates.ALL.contains(status)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Unknown shipment state: " + status);
        }

        List<Map<String, Object>> found = jdbc.queryForList(
            "SELECT id, status FROM shipments WHERE awb = ? OR tracking_no = ? LIMIT 1", awb, awb);
        if (found.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No shipment with that AWB.");
        }
        long shipmentId = ((Number) found.get(0).get("id")).longValue();
        String current = String.valueOf(found.get(0).get("status"));

        // The event id is kept on the shipment's own timeline: one row, processed once.
        Integer seen = jdbc.queryForObject(
            "SELECT count(*) FROM shipment_events WHERE shipment_id = ? AND (note = ? OR note LIKE ?)",
            Integer.class, shipmentId, eventId, eventId + " | %");
        if (seen != null && seen > 0) {
            return Map.of("shipment", shipmentId, "status", current, "replayed", true);
        }

        if (!ShipmentStates.accepts(current, status)) {
            jdbc.update("INSERT INTO shipment_events (shipment_id, status, note, at) VALUES (?, ?, ?, now())",
                shipmentId, current, "ignored " + eventId + ": " + current + " -> " + status);
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "A shipment in " + current + " cannot become " + status + ".");
        }

        jdbc.update("UPDATE shipments SET status = ?, updated_at = now() WHERE id = ?", status, shipmentId);
        jdbc.update("INSERT INTO shipment_events (shipment_id, status, note, at) VALUES (?, ?, ?, now())",
            shipmentId, status, eventId + (note.isBlank() ? "" : " | " + Mask.mask(note)));

        return Map.of("shipment", shipmentId, "status", status, "replayed", false);
    }

    private String hmac(String body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] digest = mac.doFinal(body.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (Exception e) {
            throw new IllegalStateException("The signature could not be computed", e);
        }
    }

    /** Same length, same time: a comparison that leaks timing is a comparison that can be guessed. */
    private static boolean constantTimeEquals(String given, String expected) {
        if (given == null || expected == null || given.length() != expected.length()) return false;
        int diff = 0;
        for (int i = 0; i < given.length(); i++) diff |= given.charAt(i) ^ expected.charAt(i);
        return diff == 0;
    }
}
