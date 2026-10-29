package in.equidron.auth;

import java.security.SecureRandom;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Sessions, in the shape the Node server already uses: the token is stored hashed, the role is copied
 * onto the row, and expiry is epoch seconds in a double precision column.
 */
@Service
public class SessionService {

    private static final long TTL_SECONDS = 30L * 24 * 60 * 60; // thirty days, as the Node server does
    private final JdbcTemplate jdbc;
    private final PasswordHasher hasher;
    private final SecureRandom random = new SecureRandom();

    public SessionService(JdbcTemplate jdbc, PasswordHasher hasher) {
        this.jdbc = jdbc;
        this.hasher = hasher;
    }

    public String create(UserRepository.User user) {
        byte[] raw = new byte[32];
        random.nextBytes(raw);
        String token = java.util.HexFormat.of().formatHex(raw);
        long expires = System.currentTimeMillis() / 1000 + TTL_SECONDS;
        jdbc.update("INSERT INTO sessions (token, user_id, role, expires_at) VALUES (?,?,?,?)",
            hasher.tokenHash(token), user.id(), user.role(), expires);
        return token;
    }

    /** The user behind a cookie token, or null. An expired or unknown token is not an error. */
    public UserRepository.User resolve(String token, UserRepository users) {
        if (token == null || token.isBlank()) return null;
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?",
            hasher.tokenHash(token), System.currentTimeMillis() / 1000);
        if (rows.isEmpty()) return null;
        return users.byId(((Number) rows.get(0).get("user_id")).longValue());
    }

    public void delete(String token) {
        if (token == null || token.isBlank()) return;
        jdbc.update("DELETE FROM sessions WHERE token = ?", hasher.tokenHash(token));
    }
}