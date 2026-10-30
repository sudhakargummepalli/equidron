package in.equidron.seller;

import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import in.equidron.cart.SessionUser;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/** Becoming a seller, and the staff decision that creates the shop. */
@RestController
public class SellerApplicationController {

    private final SellerApplication applications;
    private final SessionUser session;
    private final SessionService sessions;
    private final UserRepository users;

    public SellerApplicationController(SellerApplication applications, SessionUser session,
                                       SessionService sessions, UserRepository users) {
        this.applications = applications;
        this.session = session;
        this.sessions = sessions;
        this.users = users;
    }

    @GetMapping("/api/shop/seller-application")
    public Map<String, Object> view(@CookieValue(name = "equidron_session", required = false) String token) {
        return applications.draft(session.require(token));
    }

    @PostMapping("/api/shop/seller-application")
    public Map<String, Object> save(@CookieValue(name = "equidron_session", required = false) String token,
                                    @RequestBody Map<String, Object> body) {
        return applications.saveDraft(session.require(token), body);
    }

    @PostMapping("/api/shop/seller-application/submit")
    public Map<String, Object> submit(@CookieValue(name = "equidron_session", required = false) String token) {
        return applications.submit(session.require(token));
    }

    @GetMapping("/api/ops/seller-applications")
    public java.util.List<Map<String, Object>> pending(
            @CookieValue(name = "equidron_session", required = false) String token) {
        UserRepository.User staff = sessions.resolve(token, users);
        if (staff == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Please sign in.");
        if (!"ops".equals(staff.role())) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Staff only.");
        return applications.pending();
    }

    @PostMapping("/api/ops/seller-applications/{userId}/{decision}")
    public Map<String, Object> review(@CookieValue(name = "equidron_session", required = false) String token,
                                      @PathVariable long userId, @PathVariable String decision) {
        UserRepository.User staff = sessions.resolve(token, users);
        if (staff == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Please sign in.");
        if (!"ops".equals(staff.role())) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Staff only.");
        if (!java.util.List.of("approve", "reject").contains(decision)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unknown decision.");
        }
        return applications.review(userId, "approve".equals(decision));
    }
}