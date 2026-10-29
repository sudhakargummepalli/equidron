package in.equidron.auth;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * Sign-in, in the shape the browser already expects: a JSON body, a cookie, and a user object with
 * the same field names the AngularJS pages read.
 */
@RestController
@RequestMapping("/api/shop")
public class AuthController {

    private static final String COOKIE = "equidron_session";
    private final UserRepository users;
    private final SessionService sessions;
    private final PasswordHasher hasher;

    public AuthController(UserRepository users, SessionService sessions, PasswordHasher hasher) {
        this.users = users;
        this.sessions = sessions;
        this.hasher = hasher;
    }

    @PostMapping("/login")
    public ResponseEntity<Map<String, Object>> login(@RequestBody Map<String, String> body, HttpServletResponse res) {
        String email = body.getOrDefault("email", "").trim();
        String password = body.getOrDefault("password", "");
        UserRepository.User user = users.byEmail(email);
        boolean ok = user != null
            && user.deletedAt() == null
            && !"agent".equals(user.role())
            && hasher.matches(password, user.algo(), user.salt(), user.hash());
        if (!ok) {
            // One message for both cases: a different answer for "no such account" tells an attacker
            // which half of the guess was right.
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(Map.of("error", "That email and password do not match."));
        }
        String token = sessions.create(user);
        Cookie cookie = new Cookie(COOKIE, token);
        cookie.setHttpOnly(true);
        cookie.setPath("/");
        cookie.setMaxAge((int) (30L * 24 * 60 * 60));
        res.addCookie(cookie);
        return ResponseEntity.ok(Map.of("user", view(user)));
    }

    @GetMapping("/me")
    public ResponseEntity<Map<String, Object>> me(HttpServletRequest req) {
        UserRepository.User user = current(req);
        return user == null ? ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("error", "Please sign in."))
            : ResponseEntity.ok(Map.of("user", view(user)));
    }

    @PostMapping("/logout")
    public ResponseEntity<Map<String, Object>> logout(HttpServletRequest req, HttpServletResponse res) {
        sessions.delete(cookie(req));
        Cookie cookie = new Cookie(COOKIE, "");
        cookie.setPath("/");
        cookie.setMaxAge(0);
        res.addCookie(cookie);
        return ResponseEntity.ok(Map.of("ok", true));
    }

    private UserRepository.User current(HttpServletRequest req) {
        return sessions.resolve(cookie(req), users);
    }

    private static String cookie(HttpServletRequest req) {
        if (req.getCookies() == null) return null;
        for (Cookie c : req.getCookies()) if (COOKIE.equals(c.getName())) return c.getValue();
        return null;
    }

    private static Map<String, Object> view(UserRepository.User u) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", u.id());
        out.put("email", u.email());
        out.put("name", u.name());
        out.put("role", u.role());
        out.put("is_sample", u.sample());
        return out;
    }
}