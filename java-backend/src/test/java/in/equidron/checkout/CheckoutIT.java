package in.equidron.checkout;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import in.equidron.auth.PasswordHasher;
import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.HttpClientErrorException;

/**
 * Checkout against the real schema. The three things that must hold: an order is created once per
 * idempotency key, stock is reserved rather than guessed, and the cart is emptied in the same
 * transaction.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class CheckoutIT {

    @Autowired TestRestTemplate http;
    @Autowired JdbcTemplate jdbc;
    @Autowired SessionService sessions;
    @Autowired UserRepository users;
    @Autowired PasswordHasher hasher;

    private long userId;
    private long offerId;
    private long addressId;
    private String cookie;

    @BeforeEach
    void ready() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        String email = "checkout-test@example.com";
        for (String sql : new String[] {
            "DELETE FROM idempotency_keys WHERE user_id IN (SELECT id FROM users WHERE email = ?)",
            "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE user_id IN (SELECT id FROM users WHERE email = ?))",
            "DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE user_id IN (SELECT id FROM users WHERE email = ?))",
            "DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE email = ?)",
            "DELETE FROM cart_items WHERE user_id IN (SELECT id FROM users WHERE email = ?)",
            "DELETE FROM addresses WHERE user_id IN (SELECT id FROM users WHERE email = ?)",
            "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)",
            // Placing an order now queues its confirmation email, and that outbox row references the user.
            // Without this the cleanup fails on a foreign key - the order email working exactly as intended.
            "DELETE FROM outbox WHERE user_id IN (SELECT id FROM users WHERE email = ?)",
            "DELETE FROM users WHERE email = ?" }) {
            jdbc.update(sql, email);
        }
        PasswordHasher.Hashed h = hasher.hash("checkout-password");
        userId = jdbc.queryForObject(
            "INSERT INTO users (email, name, role, pw_algo, pw_salt, pw_hash, created_at) VALUES (?, 'Checkout Tester', 'customer', ?, ?, ?, now()) RETURNING id",
            Long.class, email, h.algo(), h.salt(), h.hash());
        addressId = jdbc.queryForObject(
            "INSERT INTO addresses (user_id, name, line1, city, pincode, phone) VALUES (?, 'Checkout Tester', '1 Test Road', 'Bengaluru', '560038', '9800000001') RETURNING id",
            Long.class, userId);

        offerId = aSellableOffer();
        if (offerId == 0) fail("the cart test's offer must exist; run CartIT first or seed one");
        jdbc.update("UPDATE inventory SET reserved = 0, on_hand = 10 WHERE offer_id = ?", offerId);
        jdbc.update("INSERT INTO cart_items (user_id, offer_id, qty, price_at_add_paise, added_at) " +
                    "SELECT ?, ?, 2, price_paise, now() FROM offers WHERE id = ?", userId, offerId, offerId);
        cookie = "equidron_session=" + sessions.create(users.byId(userId));
    }

    private HttpHeaders headersOnly() {
        HttpHeaders h = new HttpHeaders();
        h.add(HttpHeaders.COOKIE, cookie);
        return h;
    }

    private ResponseEntity<String> post(String key) {
        HttpHeaders h = new HttpHeaders();
        h.add(HttpHeaders.COOKIE, cookie);
        h.setContentType(MediaType.APPLICATION_JSON);
        h.add("Idempotency-Key", key);
        return new org.springframework.web.client.RestTemplate().exchange(
            http.getRootUri() + "/api/shop/orders", HttpMethod.POST,
            new HttpEntity<>("{\"address_id\":" + addressId + ",\"payment_method\":\"cod\"}", h), String.class);
    }

    /**
     * A product, a shop, a warehouse and 25 units - everything an order needs, created here because a fresh
     * database has no sample catalogue. It reuses its rows on a second run instead of piling up shops.
     */
    private long aSellableOffer() {
        Long existing = jdbc.query("SELECT id FROM offers WHERE seller_id = (SELECT id FROM sellers WHERE name = 'Checkout Test Shop') AND status = 'active' LIMIT 1",
            rs -> rs.next() ? rs.getLong(1) : null);
        if (existing != null) return existing;

        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) " +
                    "VALUES ('checkout-seller@example.com', 'Checkout Seller', 'seller', 's', 'h', now()) " +
                    "ON CONFLICT (email) DO NOTHING");
        long sellerUser = jdbc.queryForObject("SELECT id FROM users WHERE email = 'checkout-seller@example.com'", Long.class);
        jdbc.update("INSERT INTO sellers (user_id, name, city) VALUES (?, 'Checkout Test Shop', 'Bengaluru') " +
                    "ON CONFLICT (user_id) DO NOTHING", sellerUser);
        long sellerId = jdbc.queryForObject("SELECT id FROM sellers WHERE user_id = ?", Long.class, sellerUser);

        long productId = jdbc.queryForObject(
            "INSERT INTO products (title, brand, category, description, specs, images, return_window_days, status, is_sample, created_at) " +
            "VALUES ('Checkout Test Item', 'TestBrand', 'Gadgets', 'An item that exists only for the checkout test.', " +
            "'{}'::jsonb, '[]'::jsonb, 10, 'live', true, now()) RETURNING id", Long.class);

        long offerId = jdbc.queryForObject(
            "INSERT INTO offers (product_id, seller_id, price_paise, mrp_paise, condition, fulfilment, handling_days, ships_to, status, updated_at) " +
            "VALUES (?, ?, 150000, 180000, 'new', 'seller', 1, '[\"ALL\"]'::jsonb, 'active', now()) RETURNING id",
            Long.class, productId, sellerId);

        jdbc.update("INSERT INTO warehouses (code, name, city, kind, seller_id) VALUES (?, 'Checkout Test Warehouse', 'Bengaluru', 'seller_dispatch', ?) " +
                    "ON CONFLICT (code) DO NOTHING", "WH-CHECKOUT-" + sellerId, sellerId);
        long warehouseId = jdbc.queryForObject("SELECT MIN(id) FROM warehouses WHERE seller_id = ?", Long.class, sellerId);
        jdbc.update("INSERT INTO inventory (offer_id, warehouse_id, on_hand, reserved) VALUES (?, ?, 25, 0) " +
                    "ON CONFLICT (offer_id, warehouse_id) DO UPDATE SET on_hand = 25", offerId, warehouseId);
        return offerId;
    }

    @Test
    void anOrderIsCreatedOnceEvenWhenTheRequestIsRepeated() {
        ResponseEntity<String> first = post("checkout-test-key-1");
        assertEquals(201, first.getStatusCode().value());
        long orderId = jdbc.queryForObject("SELECT id FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 1", Long.class, userId);
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM orders WHERE user_id = ?", Integer.class, userId));

        ResponseEntity<String> second = post("checkout-test-key-1");
        assertTrue(second.getBody().contains("\"replayed\":true"), second.getBody());
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM orders WHERE user_id = ?", Integer.class, userId),
            "a repeated key must not create a second order");
        assertTrue(second.getBody().contains("\"order_id\":" + orderId));
    }

    @Test
    void stockIsReservedAndTheCartIsEmptiedInTheSameTransaction() {
        post("checkout-test-key-2");
        Integer reserved = jdbc.queryForObject("SELECT reserved FROM inventory WHERE offer_id = ?", Integer.class, offerId);
        assertEquals(2, reserved, "two units were reserved");
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM cart_items WHERE user_id = ?", Integer.class, userId));
        String payment = jdbc.queryForObject(
            "SELECT p.status FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.user_id = ? ORDER BY p.id DESC LIMIT 1",
            String.class, userId);
        assertEquals("pending", payment, "cod is collected on delivery");
    }

    @Test
    void theOrderCanBeReadBackAndTheEventIsQueued() {
        post("checkout-test-key-4");
        long orderId = jdbc.queryForObject("SELECT id FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 1", Long.class, userId);

        String list = new org.springframework.web.client.RestTemplate().exchange(
            http.getRootUri() + "/api/shop/orders", HttpMethod.GET,
            new HttpEntity<>(headersOnly()), String.class).getBody();
        assertTrue(list.contains("\"id\":" + orderId), list);

        String one = new org.springframework.web.client.RestTemplate().exchange(
            http.getRootUri() + "/api/shop/orders/" + orderId, HttpMethod.GET,
            new HttpEntity<>(headersOnly()), String.class).getBody();
        assertTrue(one.contains("Cart Test Widget") || one.contains("\"items\":[{"), one);

        Integer queued = jdbc.queryForObject(
            "SELECT count(*) FROM events WHERE type = 'order.placed' AND entity = 'order' AND entity_id = ?",
            Integer.class, orderId);
        assertEquals(1, queued, "the email job reads this row");
    }

    @Test
    void askingForMoreThanTheStockIsRefusedAndNothingIsWritten() {
        jdbc.update("UPDATE inventory SET on_hand = 1, reserved = 0 WHERE offer_id = ?", offerId);
        HttpClientErrorException e = assertThrows(HttpClientErrorException.class, () -> post("checkout-test-key-3"));
        assertEquals(409, e.getStatusCode().value());
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM orders WHERE user_id = ?", Integer.class, userId));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM cart_items WHERE user_id = ?", Integer.class, userId),
            "the cart survives a refused checkout");
    }
}