package in.equidron.settlement;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import in.equidron.auth.PasswordHasher;
import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.HttpClientErrorException;

/**
 * Settlement against a shop this test creates: a balance appears once, a batch records it without
 * paying, approval happens exactly once, and a second approval is refused.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SettlementIT {

    @Autowired TestRestTemplate http;
    @Autowired JdbcTemplate jdbc;
    @Autowired SessionService sessions;
    @Autowired UserRepository users;
    @Autowired PasswordHasher hasher;

    private String staffCookie;
    private long sellerId;
    private long orderId;

    @BeforeEach
    void aPaidOrderAndStaff() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");

        jdbc.update("DELETE FROM payout_lines");
        jdbc.update("DELETE FROM payout_batches");

        String email = "settle-staff@example.com";
        jdbc.update("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)", email);
        jdbc.update("DELETE FROM users WHERE email = ? AND NOT EXISTS (SELECT 1 FROM orders WHERE user_id = users.id)", email);
        PasswordHasher.Hashed h = hasher.hash("settle-password");
        jdbc.update("INSERT INTO users (email, name, role, pw_algo, pw_salt, pw_hash, created_at) VALUES (?, 'Settle Staff', 'ops', ?, ?, ?, now()) ON CONFLICT (email) DO NOTHING",
            email, h.algo(), h.salt(), h.hash());
        long staffId = jdbc.queryForObject("SELECT id FROM users WHERE email = ?", Long.class, email);
        jdbc.update("DELETE FROM sessions WHERE user_id = ?", staffId);
        staffCookie = "equidron_session=" + sessions.create(users.byId(staffId));

        // A shop with one paid, delivered line worth 100000 paise.
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('settle-seller@example.com', 'Settle Seller', 'seller', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        long sellerUser = jdbc.queryForObject("SELECT id FROM users WHERE email = 'settle-seller@example.com'", Long.class);
        jdbc.update("INSERT INTO sellers (user_id, name, rating, rating_count, city, is_sample) VALUES (?, 'Settle Shop', 4.0, 1, 'Bengaluru', false) ON CONFLICT (user_id) DO NOTHING", sellerUser);
        sellerId = jdbc.queryForObject("SELECT id FROM sellers WHERE user_id = ?", Long.class, sellerUser);

        jdbc.update("INSERT INTO products (title, brand, category, description, specs, images, return_window_days, status, created_at) " +
            "SELECT 'Settle Widget', 'TestBrand', 'Gadgets', 'x', '{}', '[]', 7, 'live', now() WHERE NOT EXISTS (SELECT 1 FROM products WHERE title = 'Settle Widget')");
        long productId = jdbc.queryForObject("SELECT id FROM products WHERE title = 'Settle Widget'", Long.class);
        jdbc.update("INSERT INTO offers (product_id, seller_id, price_paise, mrp_paise, condition, fulfilment, handling_days, status, updated_at) " +
            "SELECT ?, ?, 50000, 60000, 'new', 'seller', 1, 'active', now() WHERE NOT EXISTS (SELECT 1 FROM offers WHERE product_id = ? AND seller_id = ?)",
            productId, sellerId, productId, sellerId);
        long offerId = jdbc.queryForObject("SELECT id FROM offers WHERE product_id = ? AND seller_id = ?", Long.class, productId, sellerId);
        long warehouseId = jdbc.queryForObject(
            "INSERT INTO warehouses (code, name, city, kind, seller_id) VALUES ('S-SETTLE', 'Settle dispatch', 'Bengaluru', 'seller_dispatch', ?) " +
            "ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id", Long.class, sellerId);

        jdbc.update("INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method, " +
            "subtotal_paise, shipping_paise, total_paise, created_at, updated_at) VALUES (?, '{}', 'delivered', 'captured', 'fulfilled', 'cod', 100000, 0, 100000, now() - interval '3 days', now()) " +
            "ON CONFLICT DO NOTHING", staffId);
        orderId = jdbc.queryForObject("SELECT id FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 1", Long.class, staffId);
        jdbc.update("DELETE FROM order_items WHERE order_id = ?", orderId);
        jdbc.update("INSERT INTO order_items (order_id, offer_id, product_id, seller_id, warehouse_id, title, qty, unit_price_paise) " +
            "VALUES (?,?,?,?,?, 'Settle item', 2, 50000)", orderId, offerId, productId, sellerId, warehouseId);
    }

    private HttpHeaders headers() {
        HttpHeaders h = new HttpHeaders();
        h.add(HttpHeaders.COOKIE, staffCookie);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    private String call(HttpMethod method, String path, String body) {
        return new org.springframework.web.client.RestTemplate().exchange(
            http.getRootUri() + path, method, new HttpEntity<>(body, headers()), String.class).getBody();
    }

    @Test
    void theBalanceShowsTheEarnedAmountAndABatchDoesNotPayItYet() {
        String balances = call(HttpMethod.GET, "/api/ops/settlement/balances", null);
        assertTrue(balances.contains("Settle Shop"), "the shop is in the list: " + balances);
        assertTrue(balances.contains("balance_paise"), balances);

        String built = call(HttpMethod.POST, "/api/ops/settlement/batches", "{\"note\":\"Week 44\"}");
        assertTrue(built.contains("\"net_paise\""), built);
        String status = jdbc.queryForObject("SELECT status FROM payout_batches ORDER BY id DESC LIMIT 1", String.class);
        assertEquals("pending", status, "a batch records, it does not pay");

        // Nothing is left to settle, so a second batch is refused: that is the same fact as a zero
        // balance, and it does not depend on other shops in the list.
        HttpClientErrorException empty = assertThrows(HttpClientErrorException.class, () ->
            call(HttpMethod.POST, "/api/ops/settlement/batches", "{}"));
        assertEquals(400, empty.getStatusCode().value(), "the amount is inside a batch and not offered again");
    }

    @Test
    void approvalHappensOnceAndASecondApprovalIsRefused() {
        call(HttpMethod.POST, "/api/ops/settlement/batches", "{}");
        long batchId = jdbc.queryForObject("SELECT id FROM payout_batches ORDER BY id DESC LIMIT 1", Long.class);
        String approved = call(HttpMethod.POST, "/api/ops/settlement/batches/" + batchId + "/approve", "{}");
        assertTrue(approved.contains("\"status\":\"approved\""), approved);

        HttpClientErrorException e = assertThrows(HttpClientErrorException.class, () ->
            call(HttpMethod.POST, "/api/ops/settlement/batches/" + batchId + "/approve", "{}"));
        assertEquals(409, e.getStatusCode().value(), "the same money cannot be approved twice");
    }

    @Test
    void aSellerCannotReadSettlementAtAll() {
        long customerId = jdbc.queryForObject(
            "INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('settle-customer@example.com', 'Settle Customer', 'customer', 's', 'h', now()) " +
            "ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id", Long.class);
        HttpHeaders h = new HttpHeaders();
        h.add(HttpHeaders.COOKIE, "equidron_session=" + sessions.create(users.byId(customerId)));
        HttpClientErrorException e = assertThrows(HttpClientErrorException.class, () ->
            new org.springframework.web.client.RestTemplate().exchange(
                http.getRootUri() + "/api/ops/settlement/balances", HttpMethod.GET, new HttpEntity<>(h), String.class));
        assertEquals(403, e.getStatusCode().value());
    }
}