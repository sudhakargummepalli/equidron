package in.equidron.ops;

import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/** Ops data for staff. A customer or a seller gets 403, not a filtered answer. */
@RestController
@RequestMapping("/api/ops")
public class OpsController {

    private final OpsRepository ops;
    private final SessionService sessions;
    private final UserRepository users;

    public OpsController(OpsRepository ops, SessionService sessions, UserRepository users) {
        this.ops = ops;
        this.sessions = sessions;
        this.users = users;
    }

    private void requireStaff(String token) {
        UserRepository.User user = sessions.resolve(token, users);
        if (user == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Please sign in.");
        if (!"ops".equals(user.role())) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Staff only.");
    }

    @GetMapping("/overview")
    public Map<String, Object> overview(@CookieValue(name = "equidron_session", required = false) String token) {
        requireStaff(token);
        return ops.overview();
    }

    @GetMapping("/analytics/top-sellers")
    public List<Map<String, Object>> topSellers(@CookieValue(name = "equidron_session", required = false) String token,
                                                @RequestParam(name = "days", defaultValue = "90") int days,
                                                @RequestParam(name = "limit", defaultValue = "10") int limit) {
        requireStaff(token);
        return ops.topSellers(days, limit);
    }

    @GetMapping("/stuck-payments")
    public List<Map<String, Object>> stuck(@CookieValue(name = "equidron_session", required = false) String token) {
        requireStaff(token);
        return ops.stuckPayments();
    }
}
