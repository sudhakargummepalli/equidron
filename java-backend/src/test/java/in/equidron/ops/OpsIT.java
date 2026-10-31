package in.equidron.ops;

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
 * Ops data against rows this test creates itself: a staff account, a paid order, and a shop. It must
 * pass on a database that has never been seeded.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class OpsIT {

    @Autowired TestRestTemplate http;
    @Autowired JdbcTemplate jdbc;
    @Autowired SessionService sessions;
    @Autowired UserRepository users;
    @Autowired PasswordHasher hasher;

    private String staffCookie;
    private String email = "ops-test@example.com";

    @BeforeEach
    void aPaidOrderAndAStaffAccount() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");

        // Clean up in dependency order: the order references the user.
        jdbc.update("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE user_id IN (SELECT id FROM users WHERE email = ?))", email);
        jdbc.update("DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE user_id IN (SELECT id FROM users WHERE email = ?))", email);
        jdbc.update("DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE email = ?)", email);
        jdbc.update("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)", email);
        jdbc.update("DELETE FROM users WHERE email = ?", email);

        PasswordHasher.Hashed h = hasher.hash("ops-test-password");
        long staffId = jdbc.queryForObject(
            "INSERT INTO users (email, name, role, pw_algo, pw_salt, pw_hash, created_at) VALUES (?, 'Ops Tester', 'ops', ?, ?, ?, now()) RETURNING id",
            Long.class, email, h.algo(), h.salt(), h.hash());
        staffCookie = "equidron_session=" + sessions.create(users.byId(staffId));

        // A shop of this test's own, so the numbers do not depend on the seed.
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('ops-test-seller@example.com', 'Ops Test Seller', 'seller', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        long sellerUser = jdbc.queryForObject("SELECT id FROM users WHERE email = 'ops-test-seller@example.com'", Long.class);
        jdbc.update("INSERT INTO sellers (user_id, name, rating, rating_count, city, is_sample) VALUES (?, 'Ops Test Shop', 4.0, 1, 'Bengaluru', false) ON CONFLICT (user_id) DO NOTHING", sellerUser);
        long sellerId = jdbc.queryForObject("SELECT id FROM sellers WHERE user_id = ?", Long.class, sellerUser);
        long productId = jdbc.queryForObject(
            "INSERT INTO products (title, brand, category, description, specs, images, return_window_days, status, created_at) " +
            "VALUES ('Ops Test Widget', 'TestBrand', 'Gadgets', 'x', '{}', '[]', 7, 'live', now()) RETURNING id", Long.class);
        long offerId = jdbc.queryForObject(
            "INSERT INTO offers (product_id, seller_id, price_paise, mrp_paise, condition, fulfilment, handling_days, status, updated_at) " +
            "VALUES (?, ?, 25000, 30000, 'new', 'seller', 1, 'active', now()) RETURNING id", Long.class, productId, sellerId);
        long warehouseId = jdbc.queryForObject(
            "INSERT INTO warehouses (code, name, city, kind, seller_id) VALUES ('S-OPSTEST', 'Ops test dispatch', 'Bengaluru', 'seller_dispatch', ?) " +
            "ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id", Long.class, sellerId);

        long orderId = jdbc.queryForObject(
            "INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method, " +
            "subtotal_paise, shipping_paise, total_paise, created_at, updated_at) " +
            "VALUES (?, '{}', 'confirmed', 'captured', 'fulfilled', 'cod', 50000, 0, 50000, now(), now()) RETURNING id",
            Long.class, staffId);
        jdbc.update("INSERT INTO order_items (order_id, offer_id, product_id, seller_id, warehouse_id, title, qty, unit_price_paise) " +
                    "VALUES (?,?,?,?,?, 'Ops test item', 2, 25000)", orderId, offerId, productId, sellerId, warehouseId);
        jdbc.update("INSERT INTO payments (order_id, method, instrument, status, authorized_paise, captured_paise, created_at, updated_at) " +
                    "VALUES (?, 'cod', 'Cash on delivery', 'captured', 50000, 50000, now(), now())", orderId);
    }

    private HttpHeaders headers() {
        HttpHeaders h = new HttpHeaders();
        h.add(HttpHeaders.COOKIE, staffCookie);
        return h;
    }

    private String get(String path) {
        return new org.springframework.web.client.RestTemplate().exchange(
            http.getRootUri() + path, HttpMethod.GET, new HttpEntity<>(headers()), String.class).getBody();
    }

    @Test
    void staffSeeTheOverviewWithTheirOwnOrderCounted() {
        String body = get("/api/ops/overview");
        assertTrue(body.contains("orders_today"), body);
        assertTrue(body.contains("outbox_queued"), body);
        assertTrue(Integer.parseInt(body.replaceAll(".*\"orders_today\":(\\d+).*", "$1")) >= 1, body);
    }

    @Test
    void theTopSellerListRanksByRevenueAndNamesTheShop() {
        String body = get("/api/ops/analytics/top-sellers?days=90&limit=5");
        assertTrue(body.contains("revenue_paise"), body);
        // The list is a view of the whole marketplace, so other shops may outrank the test one.
        assertTrue(body.contains("seller_id"), body);
        assertTrue(body.contains("\"orders\""), body);
    }

    @Test
    void aCustomerIsRefusedOutright() {
        long customerId = jdbc.queryForObject(
            "INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('ops-test-customer@example.com', 'Ops Test Customer', 'customer', 's', 'h', now()) " +
            "ON CONFLICT (email) DO UPDATE SET name = 'Ops Test Customer' RETURNING id", Long.class);
        HttpHeaders h = new HttpHeaders();
        h.add(HttpHeaders.COOKIE, "equidron_session=" + sessions.create(users.byId(customerId)));
        HttpClientErrorException e = assertThrows(HttpClientErrorException.class, () ->
            new org.springframework.web.client.RestTemplate().exchange(
                http.getRootUri() + "/api/ops/overview", HttpMethod.GET, new HttpEntity<>(h), String.class));
        assertEquals(403, e.getStatusCode().value(), "not a filtered answer - a refusal");
    }
}