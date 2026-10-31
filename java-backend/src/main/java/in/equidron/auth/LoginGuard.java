package in.equidron.auth;

import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Sign-in lockout: five failures in fifteen minutes lock that email for fifteen minutes.
 *
 * The rule is the Node server's, kept identical on purpose - a person who is locked out on one
 * implementation must not be free to hammer the other, and the two share the same rows.
 *
 * Failures are counted per EMAIL, not per IP: an attacker rotating addresses is a different problem, and
 * counting per email is what protects a specific account from being guessed at.
 */
@Service
public class LoginGuard {

    public static final int MAX_FAILURES = 5;
    public static final long LOCK_SECONDS = 15 * 60;

    private final JdbcTemplate jdbc;

    public LoginGuard(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static double now() {
        return System.currentTimeMillis() / 1000.0;
    }

    /** Seconds until this email may try again; 0 when it is not locked. */
    public long lockedFor(String email) {
        Double lastSuccess = jdbc.queryForObject(
            "SELECT COALESCE(MAX(at), 0) FROM login_attempts WHERE email = ? AND ok", Double.class, email);
        double since = Math.max(now() - LOCK_SECONDS, lastSuccess == null ? 0 : lastSuccess);
        List<Double> failures = jdbc.queryForList(
            "SELECT at FROM login_attempts WHERE email = ? AND NOT ok AND at > ? ORDER BY at DESC",
            Double.class, email, since);
        if (failures.size() < MAX_FAILURES) return 0;
        return Math.max(1, (long) Math.ceil(failures.get(0) + LOCK_SECONDS - now()));
    }

    public void record(String email, boolean ok) {
        jdbc.update("INSERT INTO login_attempts (email, ok, at) VALUES (?, ?, ?)", email, ok, now());
    }

    /** One audit row per sign-in, so the Ops audit panel can answer who came in and when. */
    public void auditSignIn(Long userId, String email, String role) {
        jdbc.update("INSERT INTO audit_log (actor_type, actor_id, action, entity, entity_id, at) " +
                    "VALUES ('user', ?, 'auth.signed_in', 'user', ?, now())", userId, String.valueOf(userId));
    }

    public void clear(String email) {
        jdbc.update("DELETE FROM login_attempts WHERE email = ?", email);
    }
}