package in.equidron.mail;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/** An event becomes one email, once; a failed send stays queued. */
@SpringBootTest
class EmailDispatcherIT {

    @Autowired EmailDispatcher dispatcher;
    @Autowired JdbcTemplate jdbc;
    private long orderId;

    @BeforeEach
    void anOrderAndItsEvent() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('mail-hook@example.com', 'Mail Hook', 'customer', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        long user = jdbc.queryForObject("SELECT id FROM users WHERE email = 'mail-hook@example.com'", Long.class);
        jdbc.update("DELETE FROM events WHERE entity = 'order' AND entity_id IN (SELECT id FROM orders WHERE user_id = ?)", user);
        jdbc.update("DELETE FROM orders WHERE user_id = ?", user);
        orderId = jdbc.queryForObject(
            "INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method, " +
            "subtotal_paise, shipping_paise, total_paise, created_at, updated_at) " +
            "VALUES (?, '{}', 'confirmed', 'captured', 'unfulfilled', 'cod', 22900, 0, 22900, now(), now()) RETURNING id",
            Long.class, user);
        jdbc.update("UPDATE events SET dispatched_at = now() WHERE dispatched_at IS NULL");
        jdbc.update("INSERT INTO events (type, entity, entity_id, payload, created_at) VALUES ('order.placed', 'order', ?, '{}'::jsonb, now())", orderId);
    }

    @Test
    void theOrderEventBecomesOneEmailAndIsMarkedDispatched() {
        List<Long> sentFor = new ArrayList<>();
        int sent = dispatcher.drain(event -> {
            Map<String, Object> details = dispatcher.details(event.orderId());
            EmailService.Message message = EmailService.confirmation(
                event.orderId(), (String) details.get("name"),
                ((Number) details.get("total_paise")).longValue(), (String) details.get("payment_method"));
            assertTrue(message.body().contains("Rs. 229.00"), message.body());
            sentFor.add(event.orderId());
        });
        assertEquals(1, sent);
        assertEquals(List.of(orderId), sentFor);
        assertNotNull(jdbc.queryForObject("SELECT dispatched_at FROM events WHERE entity_id = ? AND type = 'order.placed'", Object.class, orderId),
            "dispatched, so it will not be sent again");

        assertEquals(0, dispatcher.drain(event -> fail("must not send twice")));
    }

    @Test
    void aFailedSendLeavesTheEventQueued() {
        assertThrows(IllegalStateException.class, () -> dispatcher.drain(event -> { throw new IllegalStateException("smtp down"); }));
        assertNull(jdbc.queryForObject("SELECT dispatched_at FROM events WHERE entity_id = ? AND type = 'order.placed'", Object.class, orderId),
            "not dispatched, so it is retried");
    }
}