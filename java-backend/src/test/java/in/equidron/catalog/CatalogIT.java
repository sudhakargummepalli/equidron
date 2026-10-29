package in.equidron.catalog;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Search and product detail against the real schema, with a product created by the test itself -
 * the Java database holds no marketplace data yet, and a test that needs seeding is a test that
 * fails on a fresh machine.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class CatalogIT {

    @Autowired TestRestTemplate http;
    @Autowired JdbcTemplate jdbc;

    private long productId;
    private long offerId;

    @BeforeEach
    void seedOneProduct() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("DELETE FROM inventory WHERE offer_id IN (SELECT id FROM offers WHERE product_id IN (SELECT id FROM products WHERE title = 'Java Test Widget'))");
        jdbc.update("DELETE FROM offers WHERE product_id IN (SELECT id FROM products WHERE title = 'Java Test Widget')");
        jdbc.update("DELETE FROM products WHERE title = 'Java Test Widget'");

        productId = jdbc.queryForObject(
            "INSERT INTO products (title, brand, category, description, specs, images, return_window_days, status, created_at) " +
            "VALUES ('Java Test Widget', 'TestBrand', 'Gadgets', 'A widget for tests.', '{}', '[]', 7, 'live', now()) RETURNING id",
            Long.class);

        String email = "java-seller-" + productId + "@example.com";
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES (?, 'Java Seller', 'seller', 's', 'h', now()) ON CONFLICT (email) DO NOTHING", email);
        Long sellerId = jdbc.queryForObject("SELECT id FROM users WHERE email = ?", Long.class, email);
        jdbc.update("INSERT INTO sellers (user_id, name, rating, rating_count, city, is_sample) VALUES (?, 'Java Test Seller', 4.5, 12, 'Bengaluru', false) ON CONFLICT (user_id) DO NOTHING", sellerId);
        Long shopId = jdbc.queryForObject("SELECT id FROM sellers WHERE user_id = ?", Long.class, sellerId);

        offerId = jdbc.queryForObject(
            "INSERT INTO offers (product_id, seller_id, price_paise, mrp_paise, condition, fulfilment, handling_days, status, updated_at) " +
            "VALUES (?, ?, 199900, 249900, 'new', 'seller', 1, 'active', now()) RETURNING id",
            Long.class, productId, shopId);

        Long warehouseId = jdbc.queryForObject(
            "INSERT INTO warehouses (code, name, city, kind, seller_id) VALUES (?, 'Java test dispatch', 'Bengaluru', 'seller_dispatch', ?) RETURNING id",
            Long.class, "S-JAVA-" + offerId, shopId);
        jdbc.update("INSERT INTO inventory (offer_id, warehouse_id, on_hand, reserved) VALUES (?,?, 5, 0)", offerId, warehouseId);
    }

    @Test
    void searchFindsTheProductAndReportsTheLowestPrice() {
        String body = http.getForObject(http.getRootUri() + "/api/shop/search?q=widget", String.class);
        assertNotNull(body);
        assertTrue(body.contains("Java Test Widget"), body);
        assertTrue(body.contains("199900"), "the offer price is in the result: " + body);
    }

    @Test
    void productDetailCarriesTheSellerAndStock() {
        String body = http.getForObject(http.getRootUri() + "/api/shop/products/" + productId, String.class);
        assertTrue(body.contains("Java Test Seller"), body);
        assertTrue(body.contains("Bengaluru"), body);
        assertTrue(body.contains("\"available\":5") || body.contains("\"available\": 5"), body);
    }

    @Test
    void anUnknownProductIsANotFound() {
        int status = http.getForEntity(http.getRootUri() + "/api/shop/products/99999999", String.class).getStatusCode().value();
        assertEquals(404, status);
    }
}