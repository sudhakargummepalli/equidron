package in.equidron.rights;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;

/** Export is scoped to the caller; deletion needs the literal word and keeps the history. */
@SpringBootTest
class DataRightsIT {

    @Autowired DataRights rights;
    @Autowired JdbcTemplate jdbc;
    private long userId;

    @BeforeEach
    void twoAccountsWithAnOrderEach() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('rights-a@example.com', 'Rights A', 'customer', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('rights-b@example.com', 'Rights B', 'customer', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        userId = jdbc.queryForObject("SELECT id FROM users WHERE email = 'rights-a@example.com'", Long.class);
        long other = jdbc.queryForObject("SELECT id FROM users WHERE email = 'rights-b@example.com'", Long.class);
        for (long id : new long[] { userId, other }) {
            jdbc.update("DELETE FROM orders WHERE user_id = ?", id);
            jdbc.queryForObject("INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method, " +
                "subtotal_paise, shipping_paise, total_paise, created_at, updated_at) " +
                "VALUES (?, '{}', 'delivered', 'captured', 'fulfilled', 'cod', 1000, 0, 1000, now(), now()) RETURNING id", Long.class, id);
        }
    }

    @Test
    void theExportContainsOnlyTheCallersRows() {
        Map<String, Object> data = rights.exportFor(userId);
        assertEquals("rights-a@example.com", ((Map<?, ?>) data.get("account")).get("email"));
        assertEquals(1, ((List<?>) data.get("orders")).size());
    }

    @Test
    void deletionNeedsTheWordAndAnonymisesTheAccount() {
        assertThrows(ResponseStatusException.class, () -> rights.deleteAccount(userId, "delete"));
        Map<String, Object> out = rights.deleteAccount(userId, "DELETE");
        assertEquals(true, out.get("deleted"));
        assertEquals(1, out.get("orders_kept"), "history stays truthful for tax and accounting");
        assertEquals("deleted-" + userId + "@invalid",
            jdbc.queryForObject("SELECT email FROM users WHERE id = ?", String.class, userId));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM addresses WHERE user_id = ?", Integer.class, userId));
        assertThrows(ResponseStatusException.class, () -> rights.deleteAccount(userId, "DELETE"), "already deleted is a 409");
    }
}