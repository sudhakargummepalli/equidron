package in.equidron.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * One-time codes: issued, stored hashed, and used once.
 *
 * Hashing with the account id and the purpose means a leaked row cannot be replayed for another
 * account or another reason, and reading the table never hands anyone a working code.
 */
@Component
public class Codes {

    public static final int MAX_TRIES = 5;
    public static final long TTL_SECONDS = 30 * 60;

    private final JdbcTemplate jdbc;
    private final SecureRandom random = new SecureRandom();

    public Codes(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Shared so other one-time codes (the Telegram link) use the same shape. */
    public static String hash(long userId, String purpose, String code) {
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(sha.digest((userId + ":" + purpose + ":" + code).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 is required", e);
        }
    }

    public String issue(long userId, String purpose) {
        String code = String.format("%06d", random.nextInt(1_000_000));
        jdbc.update("INSERT INTO auth_codes (user_id, purpose, code_hash, attempts, expires_at) VALUES (?, ?, ?, 0, ?)",
            userId, purpose, hash(userId, purpose, code), System.currentTimeMillis() / 1000.0 + TTL_SECONDS);
        return code;
    }

    /** True when the code is right, unused and unexpired; marks it used so it works once. */
    public boolean use(long userId, String purpose, String code) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT id, code_hash, attempts FROM auth_codes WHERE user_id = ? AND purpose = ? " +
            "AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1",
            userId, purpose, System.currentTimeMillis() / 1000.0);
        if (rows.isEmpty()) return false;
        Map<String, Object> row = rows.get(0);
        if (((Number) row.get("attempts")).intValue() >= MAX_TRIES) return false;
        boolean right = MessageDigest.isEqual(hash(userId, purpose, code).getBytes(StandardCharsets.UTF_8),
                                              String.valueOf(row.get("code_hash")).getBytes(StandardCharsets.UTF_8));
        if (!right) {
            jdbc.update("UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?", row.get("id"));
            return false;
        }
        jdbc.update("UPDATE auth_codes SET used_at = ? WHERE id = ?", System.currentTimeMillis() / 1000.0, row.get("id"));
        return true;
    }
}