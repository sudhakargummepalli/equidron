package in.equidron.auth;

import in.equidron.mail.EmailCodes;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * Forgotten passwords, for all three portals.
 *
 * The answer to "forgot" is the same whether or not the account exists - otherwise it becomes a way to
 * ask which addresses are registered. Resetting a password ends every session, because the reason for
 * the reset is usually that someone else may have the old one.
 */
@RestController
public class PasswordController {

    private final JdbcTemplate jdbc;
    private final PasswordHasher hasher;
    private final Codes codes;
    private final EmailCodes mail;

    public PasswordController(JdbcTemplate jdbc, PasswordHasher hasher, Codes codes, EmailCodes mail) {
        this.jdbc = jdbc;
        this.hasher = hasher;
        this.codes = codes;
        this.mail = mail;
    }

    private static String roleFor(String area) {
        return switch (area) {
            case "shop" -> "customer";
            case "seller" -> "seller";
            default -> "ops";
        };
    }

    private Long account(String email, String role) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT id FROM users WHERE lower(email) = ? AND (role = ? OR role = 'admin')", email, role);
        return rows.isEmpty() ? null : ((Number) rows.get(0).get("id")).longValue();
    }

    @PostMapping({"/api/shop/password/forgot", "/api/seller/password/forgot", "/api/ops/password/forgot"})
    public Map<String, Object> forgot(@RequestBody Map<String, Object> body,
                                      jakarta.servlet.http.HttpServletRequest request) {
        String email = String.valueOf(body.getOrDefault("email", "")).trim();
        String area = areaOf(request);
        Long id = account(email, roleFor(area));
        if (id != null) {
            String code = codes.issue(id, "reset_password");
            mail.sendCode(email, code);
        }
        // The same sentence either way: this route must not become a directory of accounts.
        return Map.of("ok", true, "message", "If that email has an account here, we sent a reset code to it.");
    }

    @PostMapping({"/api/shop/password/reset", "/api/seller/password/reset", "/api/ops/password/reset"})
    public Map<String, Object> reset(@RequestBody Map<String, Object> body,
                                     jakarta.servlet.http.HttpServletRequest request) {
        String email = String.valueOf(body.getOrDefault("email", "")).trim();
        String code = String.valueOf(body.getOrDefault("code", "")).trim();
        String password = String.valueOf(body.getOrDefault("password", ""));
        String area = areaOf(request);
        if (password.length() < 8) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Password must be at least 8 characters.");

        Long id = account(email, roleFor(area));
        if (id == null || !codes.use(id, "reset_password", code)) {
            return Map.of("ok", false, "error", "That code isn't right or has expired. Ask for a new one.");
        }
        PasswordHasher.Hashed h = hasher.hash(password);
        jdbc.update("UPDATE users SET pw_algo = ?, pw_salt = ?, pw_hash = ?, email_verified = true WHERE id = ?",
            h.algo(), h.salt(), h.hash(), id);
        jdbc.update("DELETE FROM sessions WHERE user_id = ?", id);
        return Map.of("ok", true);
    }

    private static String areaOf(jakarta.servlet.http.HttpServletRequest request) {
        String path = request.getRequestURI();
        if (path.startsWith("/api/seller")) return "seller";
        if (path.startsWith("/api/ops")) return "ops";
        return "shop";
    }
}