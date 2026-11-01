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

    private static boolean migrated;

    /**
     * A test that needs tables must create them, or it only passes on a machine where the server has run
     * before. Flyway applies the migrations from the jar's own classpath, which is also what CI exercises.
     */
    private JdbcTemplate jdbc() {
        DriverManagerDataSource ds = new DriverManagerDataSource(
            System.getenv().getOrDefault("DATABASE_URL", "jdbc:postgresql://127.0.0.1:5432/equidron_test"),
            System.getenv().getOrDefault("DATABASE_USER", "equidron"),
            System.getenv().getOrDefault("DATABASE_PASSWORD", "equidron-local"));
        if (!migrated) {
            synchronized (OutboxServiceTest.class) {
                if (!migrated) {
                    // The migrations are named 20261017000000_initial_schema.sql, not V1__initial.sql, so the
                    // prefix and separator must match what the application sets or Flyway finds nothing.
                    org.flywaydb.core.Flyway.configure()
                        .dataSource(ds)
                        .locations("classpath:db/migration")
                        .sqlMigrationPrefix("")
                        .sqlMigrationSeparator("_")
                        .baselineOnMigrate(true)
                        .load()
                        .migrate();
                    migrated = true;
                }
            }
        }
        return new JdbcTemplate(ds);
    }

    /** One account for the test to own, created if it is not there. */
    private static long ensureUser(JdbcTemplate jdbc) {
        Long existing = jdbc.query("SELECT id FROM users WHERE email = 'outbox-test@example.com'",
            rs -> rs.next() ? rs.getLong(1) : null);
        if (existing != null) return existing;
        return jdbc.queryForObject(
            "INSERT INTO users (email, name, role, pw_algo, pw_salt, pw_hash, created_at) " +
            "VALUES ('outbox-test@example.com', 'Outbox Test', 'customer', 'locked', 'locked', repeat('0', 64), now()) " +
            "RETURNING id", Long.class);
    }

    @Test
    void aFailureRetriesThenGivesUp() {
        JdbcTemplate jdbc = jdbc();
        OutboxService outbox = new OutboxService(jdbc);
        long userId = ensureUser(jdbc);

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
        long userId = ensureUser(jdbc);

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
        long userId = ensureUser(jdbc);

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
        long userId = ensureUser(jdbc);
        assertTrue(List.of("en", "hi", "te").contains(outbox.languageOf(userId)));
    }
}