package in.equidron.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * Registration, in the two steps the pages already use: register, then confirm the emailed code.
 *
 * The account exists after the first step but cannot sign in until the code is entered - otherwise the
 * email field would be decoration. Codes live in auth_codes with an expiry, a try limit and a used_at,
 * and the code itself is stored hashed so reading the table does not hand anyone an account.
 */
@RestController
@RequestMapping("/api/shop")
public class RegisterController {

    private static final int MAX_TRIES = 5;
    private static final long TTL_SECONDS = 30 * 60;
    private final JdbcTemplate jdbc;
    private final PasswordHasher hasher;
    private final SessionService sessions;
    private final UserRepository users;
    private final MailPort mail;
    private final SecureRandom random = new SecureRandom();

    public RegisterController(JdbcTemplate jdbc, PasswordHasher hasher, SessionService sessions, UserRepository users, MailPort mail) {
        this.jdbc = jdbc;
        this.hasher = hasher;
        this.sessions = sessions;
        this.users = users;
        this.mail = mail;
    }

    private String codeHash(long userId, String code) {
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(sha.digest((userId + ":verify_email:" + code).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 is required", e);
        }
    }

    /** Six digits, stored as a hash; the plain code goes into the email only. */
    private String issue(long userId) {
        String code = String.format("%06d", random.nextInt(1_000_000));
        jdbc.update("INSERT INTO auth_codes (user_id, purpose, code_hash, attempts, expires_at) VALUES (?, 'verify_email', ?, 0, ?)",
            userId, codeHash(userId, code), System.currentTimeMillis() / 1000.0 + TTL_SECONDS);
        return code;
    }

    @PostMapping("/register")
    public ResponseEntity<Map<String, Object>> register(@RequestBody Map<String, Object> body) {
        String name = String.valueOf(body.getOrDefault("name", "")).trim();
        String email = String.valueOf(body.getOrDefault("email", "")).trim().toLowerCase();
        String password = String.valueOf(body.getOrDefault("password", ""));
        if (name.length() < 2) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Tell us your name.");
        if (!email.matches("[^@\\s]+@[^@\\s]+\\.[^@\\s]{2,}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "That email address does not look right.");
        }
        if (password.length() < 8) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Password must be at least 8 characters.");
        if (jdbc.queryForObject("SELECT count(*) FROM users WHERE lower(email) = ?", Integer.class, email) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "An account with that email already exists.");
        }

        PasswordHasher.Hashed h = hasher.hash(password);
        Long id = jdbc.queryForObject(
            "INSERT INTO users (email, name, role, pw_algo, pw_salt, pw_hash, email_verified, created_at) " +
            "VALUES (?, ?, 'customer', ?, ?, ?, false, now()) RETURNING id",
            Long.class, email, name, h.algo(), h.salt(), h.hash());
        String code = issue(id);
        if (mail != null) { try { mail.sendCode(email, code); } catch (RuntimeException ignored) { /* the code is issued; email failure must not lose the account */ } }
        return ResponseEntity.status(HttpStatus.CREATED)
            .body(Map.of("needs_verification", true, "email", email));
    }

    @PostMapping("/verify-email")
    public ResponseEntity<Map<String, Object>> verify(@RequestBody Map<String, Object> body,
                                                      jakarta.servlet.http.HttpServletResponse res) {
        String email = String.valueOf(body.getOrDefault("email", "")).trim().toLowerCase();
        String code = String.valueOf(body.getOrDefault("code", "")).trim();
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT id FROM users WHERE lower(email) = ? AND role = 'customer'", email);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "That code isn't right or has expired.");
        long userId = ((Number) rows.get(0).get("id")).longValue();

        List<Map<String, Object>> codes = jdbc.queryForList(
            "SELECT id, code_hash, attempts FROM auth_codes WHERE user_id = ? AND purpose = 'verify_email' " +
            "AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1",
            userId, System.currentTimeMillis() / 1000.0);
        if (codes.isEmpty()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "That code isn't right or has expired.");
        Map<String, Object> row = codes.get(0);
        if (((Number) row.get("attempts")).intValue() >= MAX_TRIES) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Too many tries. Ask for a new code.");
        }
        if (!MessageDigest.isEqual(codeHash(userId, code).getBytes(StandardCharsets.UTF_8),
                                   String.valueOf(row.get("code_hash")).getBytes(StandardCharsets.UTF_8))) {
            jdbc.update("UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?", row.get("id"));
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "That code isn't right or has expired.");
        }
        jdbc.update("UPDATE auth_codes SET used_at = ? WHERE id = ?", System.currentTimeMillis() / 1000.0, row.get("id"));
        jdbc.update("UPDATE users SET email_verified = true WHERE id = ?", userId);

        UserRepository.User user = users.byId(userId);
        jakarta.servlet.http.Cookie cookie = new jakarta.servlet.http.Cookie("equidron_session", sessions.create(user));
        cookie.setHttpOnly(true);
        cookie.setPath("/");
        cookie.setMaxAge(30 * 24 * 60 * 60);
        res.addCookie(cookie);
        return ResponseEntity.ok(Map.of("user", Map.of("id", userId, "email", email, "name", user.name(), "role", "customer")));
    }

    @PostMapping("/verify-email/resend")
    public Map<String, Object> resend(@RequestBody Map<String, Object> body) {
        String email = String.valueOf(body.getOrDefault("email", "")).trim().toLowerCase();
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT id FROM users WHERE lower(email) = ? AND role = 'customer' AND NOT email_verified", email);
        if (!rows.isEmpty()) {
            String code = issue(((Number) rows.get(0).get("id")).longValue());
            if (mail != null) mail.sendCode(email, code);
        }
        return Map.of("sent", true);
    }

    /** What this controller needs from email, kept small so a test can stand in for it. */
    public interface MailPort {
        void sendCode(String email, String code);
    }
}