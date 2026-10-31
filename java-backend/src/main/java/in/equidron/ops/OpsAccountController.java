package in.equidron.ops;

import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/** The Ops portal's own account routes: who am I, and sign out. */
@RestController
@RequestMapping("/api/ops")
public class OpsAccountController {

    private final SessionService sessions;
    private final UserRepository users;

    public OpsAccountController(SessionService sessions, UserRepository users) {
        this.sessions = sessions;
        this.users = users;
    }

    @GetMapping("/me")
    public Map<String, Object> me(@CookieValue(name = "equidron_session", required = false) String token) {
        UserRepository.User user = sessions.resolve(token, users);
        if (user == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Please sign in.");
        if (!"ops".equals(user.role())) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Staff only.");
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", user.id());
        view.put("email", user.email());
        view.put("name", user.name());
        view.put("role", user.role());
        return Map.of("user", view, "demo", false);
    }

    @PostMapping("/logout")
    public Map<String, Object> logout(@CookieValue(name = "equidron_session", required = false) String token) {
        sessions.delete(token);
        return Map.of("ok", true);
    }
}