package in.equidron.auth;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * Create an account.
 *
 * Same rules as the Node server: a name, a plausible email, a password of at least eight characters,
 * one account per email. The password is stored in the format both servers verify, so a person can
 * sign in on either side afterwards.
 */
@RestController
@RequestMapping("/api/shop")
public class SignupController {

    private static final String COOKIE = "equidron_session";
    private final JdbcTemplate jdbc;
    private final PasswordHasher hasher;
    private final SessionService sessions;
    private final UserRepository users;

    public SignupController(JdbcTemplate jdbc, PasswordHasher hasher, SessionService sessions, UserRepository users) {
        this.jdbc = jdbc;
        this.hasher = hasher;
        this.sessions = sessions;
        this.users = users;
    }

    @PostMapping("/signup")
    public ResponseEntity<Map<String, Object>> signup(@RequestBody Map<String, Object> body, HttpServletResponse res) {
        String name = String.valueOf(body.getOrDefault("name", "")).trim();
        String email = String.valueOf(body.getOrDefault("email", "")).trim().toLowerCase();
        String password = String.valueOf(body.getOrDefault("password", ""));

        if (name.length() < 2) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Tell us your name.");
        if (!email.matches("[^@\\s]+@[^@\\s]+\\.[^@\\s]{2,}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "That email address does not look right.");
        }
        if (password.length() < 8) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Password must be at least 8 characters.");

        Integer taken = jdbc.queryForObject("SELECT count(*) FROM users WHERE lower(email) = ?", Integer.class, email);
        if (taken != null && taken > 0) {
            // Same message whether the account exists or not is not possible here: the person is signing
            // up, so telling them the email is taken is the honest and useful answer.
            throw new ResponseStatusException(HttpStatus.CONFLICT, "An account with that email already exists.");
        }

        PasswordHasher.Hashed hashed = hasher.hash(password);
        Long id = jdbc.queryForObject(
            "INSERT INTO users (email, name, role, pw_algo, pw_salt, pw_hash, created_at) " +
            "VALUES (?, ?, 'customer', ?, ?, ?, now()) RETURNING id",
            Long.class, email, name, hashed.algo(), hashed.salt(), hashed.hash());

        UserRepository.User user = users.byId(id);
        Cookie cookie = new Cookie(COOKIE, sessions.create(user));
        cookie.setHttpOnly(true);
        cookie.setPath("/");
        cookie.setMaxAge(30 * 24 * 60 * 60);
        res.addCookie(cookie);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id);
        out.put("email", email);
        out.put("name", name);
        out.put("role", "customer");
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("user", out));
    }
}