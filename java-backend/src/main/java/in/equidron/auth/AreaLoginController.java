package in.equidron.auth;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * Sign-in for the two portals that are not the shop: Seller Central and Ops.
 *
 * Each is the same check as the shop login, with one difference that matters: the account's role must
 * belong to that portal. A customer signing in at Ops would otherwise get a session the staff routes
 * then refuse, which reads as a broken site rather than a wrong door.
 */
@RestController
public class AreaLoginController {

    private static final String COOKIE = "equidron_session";
    private final UserRepository users;
    private final SessionService sessions;
    private final PasswordHasher hasher;
    private final LoginGuard guard;
    private final org.springframework.jdbc.core.JdbcTemplate jdbc;
    private final in.equidron.ops.StaffPermissions staffPermissions;

    public AreaLoginController(UserRepository users, SessionService sessions, PasswordHasher hasher, LoginGuard guard,
                               org.springframework.jdbc.core.JdbcTemplate jdbc,
                               in.equidron.ops.StaffPermissions staffPermissions) {
        this.users = users;
        this.sessions = sessions;
        this.hasher = hasher;
        this.guard = guard;
        this.jdbc = jdbc;
        this.staffPermissions = staffPermissions;
    }

    @PostMapping("/api/ops/login")
    public ResponseEntity<Map<String, Object>> ops(@RequestBody Map<String, String> body, HttpServletResponse res) {
        return signIn(body, Set.of("ops", "admin"), "staff", res);
    }

    @PostMapping("/api/seller/login")
    public ResponseEntity<Map<String, Object>> seller(@RequestBody Map<String, String> body, HttpServletResponse res) {
        return signIn(body, Set.of("seller", "ops", "admin"), "seller", res);
    }

    private static java.util.List<String> shopName(org.springframework.jdbc.core.JdbcTemplate jdbc, long userId) {
        return jdbc.queryForList("SELECT name FROM sellers WHERE user_id = ?", String.class, userId);
    }

    private ResponseEntity<Map<String, Object>> signIn(Map<String, String> body, Set<String> allowed,
                                                       String portal, HttpServletResponse res) {
        String email = body.getOrDefault("email", "").trim().toLowerCase();

        long wait = guard.lockedFor(email);
        if (wait > 0) {
            long minutes = Math.max(1, (wait + 59) / 60);
            return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                .body(Map.of("error", "Too many failed sign-ins. Try again in " + minutes + " minutes, or reset your password."));
        }
        String password = body.getOrDefault("password", "");
        UserRepository.User user = users.byEmail(email);
        boolean ok = user != null
            && user.deletedAt() == null
            && allowed.contains(user.role())
            && hasher.matches(password, user.algo(), user.salt(), user.hash());
        if (!ok) {
            guard.record(email, false);
            // One refusal for every reason: a different message would tell an attacker whether the
            // account exists, or exists but is not staff.
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(Map.of("error", "That email and password do not match a " + portal + " account."));
        }
        guard.record(email, true);
        guard.auditSignIn(user.id(), user.email(), user.role());
        Cookie cookie = new Cookie(COOKIE, sessions.create(user));
        cookie.setHttpOnly(true);
        cookie.setPath("/");
        cookie.setMaxAge(30 * 24 * 60 * 60);
        res.addCookie(cookie);
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", user.id());
        view.put("email", user.email());
        view.put("name", user.name());
        view.put("role", user.role());
        // The page assigns this object to vm.user and reads permissions and seller_name from it, so the
        // sign-in answer has to carry them or the console hides itself until a reload.
        if ("ops".equals(user.role()) || "admin".equals(user.role())) {
            view.put("permissions", staffPermissions.forEmail(user.email()));
        } else {
            java.util.List<String> shop = shopName(jdbc, user.id());
            if (!shop.isEmpty()) view.put("seller_name", shop.get(0));
        }
        return ResponseEntity.ok(Map.of("user", view));
    }
}