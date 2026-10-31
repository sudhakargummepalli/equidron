package in.equidron.notify;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * The outbox must retry a failure a few times and then stop, and it must write the customer's language.
 *
 * Runs against the test database, which the working rules reserve for exactly this.
 */
class OutboxServiceTest {

    private JdbcTemplate jdbc() {
        DriverManagerDataSource ds = new DriverManagerDataSource(
            System.getenv().getOrDefault("DATABASE_URL", "jdbc:postgresql://127.0.0.1:5432/equidron_test"),
            System.getenv().getOrDefault("DATABASE_USER", "equidron"),
            System.getenv().getOrDefault("DATABASE_PASSWORD", "equidron-local"));
        return new JdbcTemplate(ds);
    }

    @Test
    void aFailureRetriesThenGivesUp() {
        JdbcTemplate jdbc = jdbc();
        OutboxService outbox = new OutboxService(jdbc);
        Long userId = jdbc.queryForObject("SELECT id FROM users ORDER BY id LIMIT 1", Long.class);

        long id = outbox.queue(userId, "nobody@example.com", "retry test", "body");
        for (int attempt = 1; attempt <= 5; attempt++) {
            outbox.failed(id, "connection refused");
        }
        Map<String, Object> row = jdbc.queryForMap("SELECT status, attempts FROM outbox WHERE id = ?", id);
        assertEquals("failed", row.get("status"), "after five attempts the row is parked, not retried forever");
        assertEquals(5, ((Number) row.get("attempts")).intValue());
        jdbc.update("DELETE FROM outbox WHERE id = ?", id);
    }

    @Test
    void aFailureComesBackWhileItStillHasAttempts() {
        JdbcTemplate jdbc = jdbc();
        OutboxService outbox = new OutboxService(jdbc);
        Long userId = jdbc.queryForObject("SELECT id FROM users ORDER BY id LIMIT 1", Long.class);

        long id = outbox.queue(userId, "nobody@example.com", "retry test", "body");
        outbox.failed(id, "temporary");
        Map<String, Object> row = jdbc.queryForMap("SELECT status, attempts FROM outbox WHERE id = ?", id);
        assertEquals("pending", row.get("status"), "a first failure waits for another try");
        assertEquals(1, ((Number) row.get("attempts")).intValue());
        jdbc.update("DELETE FROM outbox WHERE id = ?", id);
    }

    @Test
    void theConfirmationIsWrittenInTheCustomersLanguage() {
        JdbcTemplate jdbc = jdbc();
        OutboxService outbox = new OutboxService(jdbc);
        Long userId = jdbc.queryForObject("SELECT id FROM users ORDER BY id LIMIT 1", Long.class);

        long id = outbox.orderConfirmation(userId, "someone@example.com", 36, 22900, "te");
        String subject = jdbc.queryForObject("SELECT subject FROM outbox WHERE id = ?", String.class, id);
        String body = jdbc.queryForObject("SELECT body FROM outbox WHERE id = ?", String.class, id);
        assertTrue(subject.contains("ఆర్డర్"), "Telugu subject: " + subject);
        assertTrue(body.contains("మొత్తం"), "Telugu total line: " + body);
        assertTrue(body.contains("36"), "the order id stays readable in every language");
        jdbc.update("DELETE FROM outbox WHERE id = ?", id);
    }

    @Test
    void anUnsetLanguageFallsBackToEnglish() {
        JdbcTemplate jdbc = jdbc();
        OutboxService outbox = new OutboxService(jdbc);
        Long userId = jdbc.queryForObject("SELECT id FROM users ORDER BY id LIMIT 1", Long.class);
        assertTrue(List.of("en", "hi", "te").contains(outbox.languageOf(userId)));
    }
}