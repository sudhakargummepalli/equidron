package in.equidron.auth;

import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** The rows the sign-in path needs. Same columns the Node server reads and writes. */
@Repository
public class UserRepository {

    private final JdbcTemplate jdbc;

    public UserRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record User(long id, String email, String name, String role, boolean sample,
                       String algo, String salt, String hash, String deletedAt) {}

    public User byEmail(String email) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT id, email, name, role, is_sample, pw_algo, pw_salt, pw_hash, deleted_at::text AS deleted_at " +
            "FROM users WHERE lower(email) = lower(?)", email);
        return rows.isEmpty() ? null : toUser(rows.get(0));
    }

    public User byId(long id) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT id, email, name, role, is_sample, pw_algo, pw_salt, pw_hash, deleted_at::text AS deleted_at " +
            "FROM users WHERE id = ?", id);
        return rows.isEmpty() ? null : toUser(rows.get(0));
    }

    private static User toUser(Map<String, Object> r) {
        return new User(
            ((Number) r.get("id")).longValue(),
            (String) r.get("email"),
            (String) r.get("name"),
            (String) r.get("role"),
            Boolean.TRUE.equals(r.get("is_sample")),
            (String) r.get("pw_algo"),
            (String) r.get("pw_salt"),
            (String) r.get("pw_hash"),
            (String) r.get("deleted_at"));
    }
}