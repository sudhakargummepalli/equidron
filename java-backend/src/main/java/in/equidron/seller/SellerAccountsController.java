package in.equidron.seller;

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
 * The seller accounts the sign-in page lists, so a demo does not need somebody to remember addresses.
 *
 * Off by default and switched on for a local demo, because this is the one endpoint that hands out
 * account emails without a session. On a real deployment it stays off: publishing your sellers'
 * addresses so anybody can try their passwords is a bad trade.
 */
@RestController
public class SellerAccountsController {

    private final JdbcTemplate jdbc;
    private final boolean enabled;

    public SellerAccountsController(JdbcTemplate jdbc, @Value("${equidron.showAccounts:false}") boolean enabled) {
        this.jdbc = jdbc;
        this.enabled = enabled;
    }

    @GetMapping("/api/seller/accounts")
    public Map<String, Object> accounts() {
        if (!enabled) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Not available.");
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT u.email, s.name AS shop, s.city, " +
            "       (SELECT count(*) FROM offers o WHERE o.seller_id = s.id AND o.status = 'active') AS active_offers, " +
            "       (u.pw_algo = 'locked') AS locked " +
            "FROM sellers s JOIN users u ON u.id = s.user_id ORDER BY s.id");
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            Map<String, Object> account = new LinkedHashMap<>(row);
            account.put("label", row.get("shop") + (Boolean.TRUE.equals(row.get("locked")) ? " (closed)" : ""));
            out.add(account);
        }
        return Map.of("accounts", out, "password", "equidron-demo");
    }
}