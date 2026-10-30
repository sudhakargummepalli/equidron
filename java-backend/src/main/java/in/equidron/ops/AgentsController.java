package in.equidron.ops;

import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * Read-only view of the agents. Deliberately no endpoint turns one on, raises a budget or changes a
 * level: those go through Ops with an audit row, and a read-only slice should not quietly gain the
 * power to spend money.
 */
@RestController
@RequestMapping("/api/ops/agents")
public class AgentsController {

    private final AgentsRepository agents;
    private final SessionService sessions;
    private final UserRepository users;

    public AgentsController(AgentsRepository agents, SessionService sessions, UserRepository users) {
        this.agents = agents;
        this.sessions = sessions;
        this.users = users;
    }

    private void requireStaff(String token) {
        UserRepository.User user = sessions.resolve(token, users);
        if (user == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Please sign in.");
        if (!"ops".equals(user.role())) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Staff only.");
    }

    @GetMapping
    public List<Map<String, Object>> list(@CookieValue(name = "equidron_session", required = false) String token) {
        requireStaff(token);
        return agents.list();
    }

    @GetMapping("/{id}/runs")
    public List<Map<String, Object>> runs(@CookieValue(name = "equidron_session", required = false) String token,
                                          @PathVariable String id,
                                          @RequestParam(name = "limit", defaultValue = "20") int limit) {
        requireStaff(token);
        return agents.runs(id, limit);
    }
}
