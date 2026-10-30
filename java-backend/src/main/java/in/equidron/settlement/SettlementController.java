package in.equidron.settlement;

import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/** Settlement is staff work: a seller must not see, let alone approve, a payout batch. */
@RestController
@RequestMapping("/api/ops/settlement")
public class SettlementController {

    private final SettlementRepository settlement;
    private final SessionService sessions;
    private final UserRepository users;

    public SettlementController(SettlementRepository settlement, SessionService sessions, UserRepository users) {
        this.settlement = settlement;
        this.sessions = sessions;
        this.users = users;
    }

    private UserRepository.User staff(String token) {
        UserRepository.User user = sessions.resolve(token, users);
        if (user == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Please sign in.");
        if (!"ops".equals(user.role())) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Staff only.");
        return user;
    }

    /** What the panel shows: balances and the batches already made. */
    @GetMapping
    public Map<String, Object> panel(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return Map.of("balances", settlement.balances(), "batches", settlement.batches());
    }

    @PostMapping("/run")
    public Map<String, Object> run(@CookieValue(name = "equidron_session", required = false) String token,
                                   @RequestBody(required = false) Map<String, Object> body) {
        UserRepository.User user = staff(token);
        return settlement.build(user.id(), body == null ? null : (String) body.get("note"));
    }

    @GetMapping("/balances")
    public List<Map<String, Object>> balances(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return settlement.balances();
    }

    @PostMapping("/batches")
    public Map<String, Object> build(@CookieValue(name = "equidron_session", required = false) String token,
                                     @RequestBody(required = false) Map<String, Object> body) {
        UserRepository.User user = staff(token);
        String note = body == null ? null : (String) body.get("note");
        return settlement.build(user.id(), note);
    }

    @GetMapping("/batches")
    public List<Map<String, Object>> batches(@CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return settlement.batches();
    }

    @GetMapping("/batches/{id}/lines")
    public List<Map<String, Object>> lines(@CookieValue(name = "equidron_session", required = false) String token,
                                           @PathVariable long id) {
        staff(token);
        return settlement.lines(id);
    }

    @PostMapping("/batches/{id}/{decision}")
    public Map<String, Object> decide(@CookieValue(name = "equidron_session", required = false) String token,
                                      @PathVariable long id, @PathVariable String decision,
                                      @RequestBody(required = false) Map<String, Object> body) {
        UserRepository.User user = staff(token);
        if (!List.of("approve", "reject").contains(decision)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unknown decision.");
        }
        String note = body == null ? null : (String) body.get("note");
        return settlement.decide(id, "approve".equals(decision), user.id(), note);
    }
}
