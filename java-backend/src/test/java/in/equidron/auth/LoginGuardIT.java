package in.equidron.auth;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The lockout rule, on real rows: five failures lock the email for fifteen minutes, one success clears
 * the count, and every sign-in leaves an audit row.
 */
@SpringBootTest
class LoginGuardIT {

    @Autowired LoginGuard guard;
    @Autowired JdbcTemplate jdbc;
    private final String email = "lockout@example.com";

    @BeforeEach
    void clean() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("DELETE FROM login_attempts WHERE email = ?", email);
        jdbc.update("DELETE FROM audit_log WHERE actor_type = 'user' AND action = 'auth.signed_in' AND entity_id = '999999'");
    }

    @Test
    void fourFailuresDoNotLockAndTheFifthDoes() {
        for (int i = 0; i < 4; i++) {
            guard.record(email, false);
            assertEquals(0, guard.lockedFor(email), "attempt " + (i + 1) + " must not lock");
        }
        guard.record(email, false);
        long wait = guard.lockedFor(email);
        assertTrue(wait > 800 && wait <= 900, "locked for the rest of the fifteen minutes: " + wait);
    }

    @Test
    void aSuccessClearsTheCount() {
        for (int i = 0; i < 4; i++) guard.record(email, false);
        guard.record(email, true);
        for (int i = 0; i < 4; i++) guard.record(email, false);
        assertEquals(0, guard.lockedFor(email), "failures before the last success must not count");
    }

    @Test
    void oldFailuresExpire() {
        jdbc.update("INSERT INTO login_attempts (email, ok, at) VALUES (?, false, ?)", email,
            System.currentTimeMillis() / 1000.0 - 20 * 60);
        for (int i = 0; i < 4; i++) guard.record(email, false);
        assertEquals(0, guard.lockedFor(email), "a failure from twenty minutes ago is outside the window");
    }

    @Test
    void anUnlockedEmailIsNotAffected() {
        assertEquals(0, guard.lockedFor("nobody@example.com"));
    }

    @Test
    void signingInWritesAnAuditRow() {
        guard.auditSignIn(999999L, "someone@example.com", "customer");
        Integer rows = jdbc.queryForObject(
            "SELECT count(*) FROM audit_log WHERE action = 'auth.signed_in' AND entity_id = '999999'", Integer.class);
        assertEquals(1, rows);
    }
}