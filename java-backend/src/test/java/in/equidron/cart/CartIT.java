package in.equidron.cart;

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

/**
 * The cart against the real schema. Every test signs in through the Java endpoints and carries the
 * cookie, so the session path is exercised too, not bypassed.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class CartIT {

    @Autowired TestRestTemplate http;
    @Autowired JdbcTemplate jdbc;
    @Autowired SessionService sessions;
    @Autowired UserRepository users;
    @Autowired PasswordHasher hasher;

    private long userId;
    private long offerId;
    private long productId;
    private String cookie;

    @BeforeEach
    void oneUserOneOffer() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        String email = "cart-test@example.com";
        jdbc.update("DELETE FROM cart_items WHERE user_id IN (SELECT id FROM users WHERE email = ?)", email);
        jdbc.update("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)", email);
        jdbc.update("DELETE FROM users WHERE email = ?", email);

        PasswordHasher.Hashed h = hasher.hash("cart-password");
        userId = jdbc.queryForObject(
            "INSERT INTO users (email, name, role, pw_algo, pw_salt, pw_hash, created_at) VALUES (?, 'Cart Tester', 'customer', ?, ?, ?, now()) RETURNING id",
            Long.class, email, h.algo(), h.salt(), h.hash());

        if (jdbc.queryForObject("SELECT count(*) FROM products WHERE title = 'Cart Test Widget'", Integer.class) == 0) {
            productId = jdbc.queryForObject(
                "INSERT INTO products (title, brand, category, description, specs, images, return_window_days, status, created_at) " +
                "VALUES ('Cart Test Widget', 'TestBrand', 'Gadgets', 'x', '{}', '[]', 7, 'live', now()) RETURNING id", Long.class);
            String sellerEmail = "cart-seller@example.com";
            jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES (?, 'Cart Seller', 'seller', 's', 'h', now()) ON CONFLICT (email) DO NOTHING", sellerEmail);
            Long sellerUser = jdbc.queryForObject("SELECT id FROM users WHERE email = ?", Long.class, sellerEmail);
            jdbc.update("INSERT INTO sellers (user_id, name, rating, rating_count, city, is_sample) VALUES (?, 'Cart Seller Shop', 4.2, 3, 'Bengaluru', false) ON CONFLICT (user_id) DO NOTHING", sellerUser);
            Long shop = jdbc.queryForObject("SELECT id FROM sellers WHERE user_id = ?", Long.class, sellerUser);
            offerId = jdbc.queryForObject(
                "INSERT INTO offers (product_id, seller_id, price_paise, mrp_paise, condition, fulfilment, handling_days, status, updated_at) " +
                "VALUES (?, ?, 150000, 200000, 'new', 'seller', 1, 'active', now()) RETURNING id", Long.class, productId, shop);
            Long wh = jdbc.queryForObject(
                "INSERT INTO warehouses (code, name, city, kind, seller_id) VALUES (?, 'Cart test dispatch', 'Bengaluru', 'seller_dispatch', ?) RETURNING id",
                Long.class, "S-CART-" + offerId, shop);
            jdbc.update("INSERT INTO inventory (offer_id, warehouse_id, on_hand, reserved) VALUES (?,?, 10, 0)", offerId, wh);
        } else {
            productId = jdbc.queryForObject("SELECT id FROM products WHERE title = 'Cart Test Widget'", Long.class);
            offerId = jdbc.queryForObject("SELECT id FROM offers WHERE product_id = ? ORDER BY id LIMIT 1", Long.class, productId);
        }

        // A session through the Java service, then the cookie the endpoints expect.
        UserRepository.User user = users.byId(userId);
        cookie = "equidron_session=" + sessions.create(user);
    }

    private HttpHeaders headers() {
        HttpHeaders h = new HttpHeaders();
        h.add(HttpHeaders.COOKIE, cookie);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    private String call(HttpMethod method, String path, String body) {
        return new org.springframework.web.client.RestTemplate().exchange(
            http.getRootUri() + path, method, new HttpEntity<>(body, headers()), String.class).getBody();
    }

    @Test
    void addingTwiceIncreasesTheQuantityAndTheSubtotal() {
        call(HttpMethod.POST, "/api/shop/cart", "{\"offer_id\":" + offerId + ",\"qty\":1}");
        String body = call(HttpMethod.POST, "/api/shop/cart", "{\"offer_id\":" + offerId + ",\"qty\":2}");
        assertTrue(body.contains("\"count\":3"), body);
        assertTrue(body.contains("\"subtotal_paise\":450000"), body);
    }

    @Test
    void settingZeroRemovesTheLineAndTheTotalFallsBackToZero() {
        call(HttpMethod.POST, "/api/shop/cart", "{\"offer_id\":" + offerId + ",\"qty\":4}");
        String body = call(HttpMethod.PUT, "/api/shop/cart/" + offerId, "{\"qty\":0}");
        assertTrue(body.contains("\"count\":0"), body);
        assertTrue(body.contains("\"subtotal_paise\":0"), body);
    }

    @Test
    void theCartIsRefusedWithoutASession() {
        var rest = new org.springframework.web.client.RestTemplate();
        assertThrows(org.springframework.web.client.HttpClientErrorException.class,
            () -> rest.getForEntity(http.getRootUri() + "/api/shop/cart", String.class));
    }
}