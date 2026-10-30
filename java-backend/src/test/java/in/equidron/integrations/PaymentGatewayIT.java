package in.equidron.integrations;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;

/** Capture against the real tables: the amount comes from the order, and it happens once. */
@SpringBootTest
class PaymentGatewayIT {

    @Autowired PaymentGateway gateway;
    @Autowired JdbcTemplate jdbc;

    private long orderId;

    @BeforeEach
    void anOrderOfFiftyThousand() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('pay-customer@example.com', 'Pay Customer', 'customer', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        long user = jdbc.queryForObject("SELECT id FROM users WHERE email = 'pay-customer@example.com'", Long.class);
        jdbc.update("DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE user_id = ?)", user);
        jdbc.update("DELETE FROM orders WHERE user_id = ?", user);
        orderId = jdbc.queryForObject(
            "INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method, " +
            "subtotal_paise, shipping_paise, total_paise, created_at, updated_at) " +
            "VALUES (?, '{}', 'payment_pending', 'pending', 'unfulfilled', 'razorpay', 50000, 0, 50000, now(), now()) RETURNING id",
            Long.class, user);
        gateway.start(orderId, user);
    }

    @Test
    void theAmountComesFromTheOrderNotFromTheCaller() {
        Map<String, Object> out = gateway.capture(orderId, "pay_test_1", null);
        assertEquals(50000L, ((Number) out.get("captured_paise")).longValue());
        assertEquals(50000, jdbc.queryForObject("SELECT captured_paise FROM payments WHERE order_id = ?", Integer.class, orderId));
        assertEquals("captured", jdbc.queryForObject("SELECT payment_status FROM orders WHERE id = ?", String.class, orderId));
    }

    @Test
    void aSecondCaptureIsRefusedAndChangesNothing() {
        gateway.capture(orderId, "pay_test_2", null);
        ResponseStatusException e = assertThrows(ResponseStatusException.class, () -> gateway.capture(orderId, "pay_test_2", null));
        assertEquals(409, e.getStatusCode().value());
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM payments WHERE order_id = ? AND status = 'captured'", Integer.class, orderId));
    }

    @Test
    void captureQueuesTheEventAndNamesTheMode() {
        gateway.capture(orderId, "pay_test_3", null);
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM events WHERE type = 'payment.captured' AND entity_id = ?", Integer.class, orderId));
        // No keys in tests, so the gateway is honest about being simulated.
        assertEquals("simulated", gateway.mode());
    }
}