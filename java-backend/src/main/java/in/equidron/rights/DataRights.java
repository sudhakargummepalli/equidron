package in.equidron.rights;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * A person's own data: export it, or delete the account.
 *
 * Export returns only rows that belong to the caller - every query is scoped by user id, in the SQL.
 * Delete keeps the orders (accounting and tax require them) and removes what identifies the person:
 * the name and email are replaced, sessions and addresses are cleared, so the account cannot be used
 * again while its history stays truthful.
 */
@Service
public class DataRights {

    private final JdbcTemplate jdbc;

    public DataRights(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Map<String, Object> exportFor(long userId) {
        List<Map<String, Object>> user = jdbc.queryForList(
            "SELECT id, email, name, role, created_at FROM users WHERE id = ?", userId);
        if (user.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No such account.");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("account", user.get(0));
        out.put("addresses", jdbc.queryForList("SELECT * FROM addresses WHERE user_id = ?", userId));
        out.put("orders", jdbc.queryForList(
            "SELECT id, status, payment_status, total_paise, created_at FROM orders WHERE user_id = ? ORDER BY id", userId));
        out.put("order_items", jdbc.queryForList(
            "SELECT oi.order_id, oi.title, oi.qty, oi.unit_price_paise FROM order_items oi " +
            "JOIN orders o ON o.id = oi.order_id WHERE o.user_id = ? ORDER BY oi.id", userId));
        out.put("invoices", jdbc.queryForList(
            "SELECT i.number, i.total_paise, i.issued_at FROM invoices i JOIN orders o ON o.id = i.order_id WHERE o.user_id = ?", userId));
        return out;
    }

    /** The literal word DELETE is the confirmation: a click cannot do this by accident. */
    @Transactional
    public Map<String, Object> deleteAccount(long userId, String confirmation) {
        if (!"DELETE".equals(confirmation)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Type DELETE to confirm.");
        }
        List<Map<String, Object>> user = jdbc.queryForList("SELECT email FROM users WHERE id = ?", userId);
        if (user.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No such account.");
        String email = (String) user.get(0).get("email");
        if (email.startsWith("deleted-")) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "That account is already deleted.");
        }
        jdbc.update("DELETE FROM sessions WHERE user_id = ?", userId);
        jdbc.update("DELETE FROM addresses WHERE user_id = ?", userId);
        jdbc.update("DELETE FROM cart_items WHERE user_id = ?", userId);
        jdbc.update("UPDATE users SET email = ?, name = 'Deleted account', deleted_at = now() WHERE id = ?",
            "deleted-" + userId + "@invalid", userId);
        return Map.of("deleted", true, "orders_kept", jdbc.queryForObject(
            "SELECT count(*) FROM orders WHERE user_id = ?", Integer.class, userId));
    }
}