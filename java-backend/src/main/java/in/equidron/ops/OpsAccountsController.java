package in.equidron.ops;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * The staff accounts the Ops sign-in page lists, for a local demo.
 *
 * Off by default for the same reason as the seller list: it hands out account emails without a session,
 * and staff addresses are the ones worth guessing at.
 */
@RestController
public class OpsAccountsController {

    private final JdbcTemplate jdbc;
    private final boolean enabled;

    public OpsAccountsController(JdbcTemplate jdbc, @Value("${equidron.showAccounts:false}") boolean enabled) {
        this.jdbc = jdbc;
        this.enabled = enabled;
    }

    @GetMapping("/api/ops/accounts")
    public Map<String, Object> accounts() {
        if (!enabled) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Not available.");
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT email, name, role, (pw_algo = 'locked') AS locked FROM users " +
            "WHERE role IN ('ops', 'admin') ORDER BY id");
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            Map<String, Object> account = new LinkedHashMap<>(row);
            account.put("label", row.get("email") + " (" + row.get("role") + ")"
                + (Boolean.TRUE.equals(row.get("locked")) ? " - closed" : ""));
            out.add(account);
        }
        return Map.of("accounts", out, "password", "equidron-demo");
    }
}