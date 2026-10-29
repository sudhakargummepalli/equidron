package in.equidron.seller;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

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
 * Seller Central against the seeded demo shop: a seller sees only their own listings, can change a
 * price inside their band, and is refused outside it or for another shop's offer.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SellerIT {

    @Autowired TestRestTemplate http;
    @Autowired JdbcTemplate jdbc;
    @Autowired SessionService sessions;
    @Autowired UserRepository users;

    private String sellerCookie;
    private long offerId;
    private long otherOfferId;

    @BeforeEach
    void signInAsSeededSeller() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        UserRepository.User seller = users.byEmail("java.techbazaar@example.com");
        assumeTrue(seller != null, "run scripts/seed-java-db.mjs first");
        sellerCookie = "equidron_session=" + sessions.create(seller);

        org.springframework.jdbc.core.JdbcTemplate j = jdbc;
        // This seller may have no offer yet; give it one so the test exercises the endpoints, not the seed.
        java.util.List<Long> mine = j.queryForList(
            "SELECT o.id FROM offers o JOIN sellers s ON s.id = o.seller_id JOIN users u ON u.id = s.user_id " +
            "WHERE u.email = 'java.techbazaar@example.com' ORDER BY o.id LIMIT 1", Long.class);
        if (mine.isEmpty()) {
            Long productId = j.queryForObject("SELECT id FROM products ORDER BY id LIMIT 1", Long.class);
            Long shopId = j.queryForObject(
                "SELECT s.id FROM sellers s JOIN users u ON u.id = s.user_id WHERE u.email = 'java.techbazaar@example.com'", Long.class);
            mine = java.util.List.of(j.queryForObject(
                "INSERT INTO offers (product_id, seller_id, price_paise, mrp_paise, condition, fulfilment, handling_days, status, updated_at) " +
                "VALUES (?, ?, 99900, 129900, 'new', 'seller', 1, 'active', now()) RETURNING id", Long.class, productId, shopId));
            Long wh = j.queryForObject(
                "INSERT INTO warehouses (code, name, city, kind, seller_id) VALUES (?, 'SellerIT dispatch', 'Bengaluru', 'seller_dispatch', ?) RETURNING id",
                Long.class, "S-SELLERIT-" + shopId, shopId);
            j.update("INSERT INTO inventory (offer_id, warehouse_id, on_hand, reserved) VALUES (?,?,6,0) ON CONFLICT DO NOTHING", mine.get(0), wh);
        }
        offerId = mine.get(0);
        otherOfferId = j.queryForObject(
            "SELECT o.id FROM offers o JOIN sellers s ON s.id = o.seller_id JOIN users u ON u.id = s.user_id " +
            "WHERE u.email = 'java.greenleaf@example.com' ORDER BY o.id LIMIT 1", Long.class);
        j.update("UPDATE offers SET price_floor_paise = 1000, price_ceiling_paise = 5000000 WHERE id = ?", offerId);
    }

    private HttpHeaders headers() {
        HttpHeaders h = new HttpHeaders();
        h.add(HttpHeaders.COOKIE, sellerCookie);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    private String get(String path) {
        return new org.springframework.web.client.RestTemplate().exchange(
            http.getRootUri() + path, HttpMethod.GET, new HttpEntity<>(headers()), String.class).getBody();
    }

    @Test
    void aSellerSeesTheirOwnListingsAndTheDashboardCounts() {
        String listings = get("/api/seller/listings");
        assertTrue(listings.contains("offer_id"), listings);
        String dashboard = get("/api/seller/dashboard");
        assertTrue(dashboard.contains("active_listings"), dashboard);
    }

    @Test
    void aPriceInsideTheBandIsAcceptedAndOneOutsideIsRefused() {
        String ok = new String(new org.springframework.web.client.RestTemplate().exchange(
            http.getRootUri() + "/api/seller/listings/" + offerId, HttpMethod.PUT,
            new HttpEntity<>("{\"price_paise\":150000,\"qty\":7}", headers()), byte[].class).getBody());
        assertTrue(ok.contains("\"updated\":true"), ok);
        assertEquals(150000, jdbc.queryForObject("SELECT price_paise FROM offers WHERE id = ?", Integer.class, offerId));
        assertEquals(7, jdbc.queryForObject("SELECT on_hand - reserved FROM inventory WHERE offer_id = ? ORDER BY warehouse_id LIMIT 1", Integer.class, offerId));

        HttpClientErrorException e = assertThrows(HttpClientErrorException.class, () ->
            new org.springframework.web.client.RestTemplate().exchange(
                http.getRootUri() + "/api/seller/listings/" + offerId, HttpMethod.PUT,
                new HttpEntity<>("{\"price_paise\":5}", headers()), byte[].class));
        assertEquals(400, e.getStatusCode().value(), "a price below the seller's own floor is refused");
    }

    @Test
    void anotherShopsOfferIsNotFoundNotEditable() {
        HttpClientErrorException e = assertThrows(HttpClientErrorException.class, () ->
            new org.springframework.web.client.RestTemplate().exchange(
                http.getRootUri() + "/api/seller/listings/" + otherOfferId, HttpMethod.PUT,
                new HttpEntity<>("{\"price_paise\":150000}", headers()), byte[].class));
        assertEquals(404, e.getStatusCode().value());
    }

    @Test
    void aCustomerCannotUseTheSellerEndpoints() {
        UserRepository.User customer = users.byEmail("java.customer@example.com");
        assumeTrue(customer != null, "run scripts/seed-java-db.mjs first");
        HttpHeaders h = new HttpHeaders();
        h.add(HttpHeaders.COOKIE, "equidron_session=" + sessions.create(customer));
        HttpClientErrorException e = assertThrows(HttpClientErrorException.class, () ->
            new org.springframework.web.client.RestTemplate().exchange(
                http.getRootUri() + "/api/seller/listings", HttpMethod.GET, new HttpEntity<>(h), String.class));
        assertEquals(403, e.getStatusCode().value());
    }
}