package in.equidron.seller;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;

/** A draft survives, an incomplete one cannot be submitted, and approval is what makes a seller. */
@SpringBootTest
class SellerApplicationIT {

    @Autowired SellerApplication applications;
    @Autowired JdbcTemplate jdbc;
    private long userId;

    @BeforeEach
    void anApplicant() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('apply@example.com', 'Applicant', 'customer', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        userId = jdbc.queryForObject("SELECT id FROM users WHERE email = 'apply@example.com'", Long.class);
        jdbc.update("DELETE FROM seller_applications WHERE user_id = ?", userId);
        jdbc.update("DELETE FROM sellers WHERE user_id = ?", userId);
        jdbc.update("UPDATE users SET role = 'customer' WHERE id = ?", userId);
    }

    private Map<String, Object> full(String pan) {
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("business_name", "Apply Shop");
        body.put("business_type", "proprietorship");
        body.put("pan", pan);
        body.put("gstin", "29ABCDE1234F1Z5");
        body.put("bank_account_name", "Applicant");
        body.put("bank_account_no", "1234567890");
        body.put("bank_ifsc", "HDFC0001234");
        body.put("pickup_line1", "1 Test Road");
        body.put("pickup_city", "Bengaluru");
        body.put("pickup_pincode", "560038");
        body.put("pickup_phone", "9800000001");
        return body;
    }

    @Test
    void aDraftIsSavedAndAnIncompleteOneCannotBeSubmitted() {
        applications.saveDraft(userId, Map.of("business_name", "Only A Name"));
        assertEquals("draft", applications.draft(userId).get("status"));
        ResponseStatusException e = assertThrows(ResponseStatusException.class, () -> applications.submit(userId));
        assertEquals(400, e.getStatusCode().value(), "a seller who cannot be paid must not be created");
    }

    @Test
    void aCompleteApplicationIsSubmittedWithKycAndApprovalMakesTheSeller() {
        applications.saveDraft(userId, full("ABCDE1234A"));
        Map<String, Object> submitted = applications.submit(userId);
        assertEquals("verified", submitted.get("kyc_status"), "the simulated PAN ending A verifies");
        assertEquals("submitted", submitted.get("status"));

        assertEquals("approved", applications.review(userId, true).get("status"));
        assertEquals("seller", jdbc.queryForObject("SELECT role FROM users WHERE id = ?", String.class, userId));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM sellers WHERE user_id = ?", Integer.class, userId));
    }

    @Test
    void aBadPanIsRefusedBeforeKyc() {
        applications.saveDraft(userId, full("NOTAPAN"));
        ResponseStatusException e = assertThrows(ResponseStatusException.class, () -> applications.submit(userId));
        assertEquals(400, e.getStatusCode().value());
    }
}