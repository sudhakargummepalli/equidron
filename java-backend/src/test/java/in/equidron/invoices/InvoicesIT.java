package in.equidron.invoices;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/** Issuing twice returns the same number, and the numbers come from the order. */
@SpringBootTest
class InvoicesIT {

    @Autowired Invoices invoices;
    @Autowired JdbcTemplate jdbc;
    private long orderId;

    @BeforeEach
    void anOrder() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('inv-customer@example.com', 'Inv Customer', 'customer', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        long user = jdbc.queryForObject("SELECT id FROM users WHERE email = 'inv-customer@example.com'", Long.class);
        jdbc.update("DELETE FROM invoices WHERE order_id IN (SELECT id FROM orders WHERE user_id = ?)", user);
        jdbc.update("DELETE FROM orders WHERE user_id = ?", user);
        orderId = jdbc.queryForObject(
            "INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method, " +
            "subtotal_paise, shipping_paise, total_paise, created_at, updated_at) " +
            "VALUES (?, '{\"state\":\"Karnataka\"}', 'delivered', 'captured', 'fulfilled', 'cod', 118000, 0, 118000, now(), now()) RETURNING id",
            Long.class, user);
    }

    @Test
    void anInvoiceBacksTheTaxOutOfTheTotalAndNumbersItself() {
        Map<String, Object> out = invoices.issue(orderId);
        String number = (String) out.get("number");
        assertTrue(number.startsWith("INV-"));
        assertEquals(118000, jdbc.queryForObject("SELECT total_paise FROM invoices WHERE order_id = ?", Integer.class, orderId));
        assertEquals(18000, jdbc.queryForObject("SELECT cgst_paise + sgst_paise + igst_paise FROM invoices WHERE order_id = ?", Integer.class, orderId));
    }

    @Test
    void issuingTwiceReturnsTheSameNumber() {
        String first = (String) invoices.issue(orderId).get("number");
        Map<String, Object> second = invoices.issue(orderId);
        assertEquals(first, second.get("number"));
        assertTrue((Boolean) second.get("existing"));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM invoices WHERE order_id = ?", Integer.class, orderId));
    }
}