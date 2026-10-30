package in.equidron.integrations;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;

/** The webhook: parsed only after verification, applied once however often it is delivered. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class PaymentWebhookIT {

    @Autowired TestRestTemplate http;
    @Autowired JdbcTemplate jdbc;
    @Autowired PaymentGateway gateway;

    private long orderId;

    @BeforeEach
    void aPendingOrder() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('wh-customer@example.com', 'WH Customer', 'customer', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        long user = jdbc.queryForObject("SELECT id FROM users WHERE email = 'wh-customer@example.com'", Long.class);
        jdbc.update("DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE user_id = ?)", user);
        jdbc.update("DELETE FROM orders WHERE user_id = ?", user);
        orderId = jdbc.queryForObject(
            "INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method, " +
            "subtotal_paise, shipping_paise, total_paise, created_at, updated_at) " +
            "VALUES (?, '{}', 'payment_pending', 'pending', 'unfulfilled', 'razorpay', 30000, 0, 30000, now(), now()) RETURNING id",
            Long.class, user);
        gateway.start(orderId, user);
    }

    private ResponseEntity<String> deliver(String body) {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        return new org.springframework.web.client.RestTemplate().postForEntity(
            http.getRootUri() + "/api/webhooks/payments", new HttpEntity<>(body, h), String.class);
    }

    private String captured() {
        return "{\"event\":\"payment.captured\",\"payload\":{\"payment\":{\"entity\":{\"id\":\"pay_wh_1\",\"notes\":{\"order_id\":\"" + orderId + "\"}}}}}";
    }

    @Test
    void aCapturedEventMarksTheOrderPaid() {
        ResponseEntity<String> out = deliver(captured());
        assertEquals(200, out.getStatusCode().value());
        assertEquals("captured", jdbc.queryForObject("SELECT payment_status FROM orders WHERE id = ?", String.class, orderId));
    }

    @Test
    void deliveringTheSameEventTwiceChangesNothingAndStillSucceeds() {
        deliver(captured());
        ResponseEntity<String> again = deliver(captured());
        assertEquals(200, again.getStatusCode().value(), "a retry is a success, not an error");
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM payments WHERE order_id = ? AND status = 'captured'", Integer.class, orderId));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM events WHERE type = 'payment.captured' AND entity_id = ?", Integer.class, orderId));
    }

    @Test
    void anEventThisServerDoesNotCareAboutIsIgnored() {
        ResponseEntity<String> out = deliver("{\"event\":\"payment.failed\",\"payload\":{}}");
        assertEquals(200, out.getStatusCode().value());
        assertEquals("pending", jdbc.queryForObject("SELECT payment_status FROM orders WHERE id = ?", String.class, orderId));
    }
}