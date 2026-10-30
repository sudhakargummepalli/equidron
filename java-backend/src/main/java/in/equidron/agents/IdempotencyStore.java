package in.equidron.agents;

import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Idempotency that survives a restart: the same table the Node server uses, keyed by the account that
 * owns the call - the agent's own user row.
 *
 * Claim-then-work: the row is inserted (status 0, no response) before the action runs, so two callers
 * with the same key cannot both run it. The response is written after, and a replay reads it back.
 */
@Repository
public class IdempotencyStore {

    private final JdbcTemplate jdbc;

    public IdempotencyStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** True when this caller now owns the key. False means somebody already claimed it. */
    public boolean claim(long userId, String key, String route) {
        return jdbc.update("INSERT INTO idempotency_keys (user_id, key, route, status, created_at) " +
                           "VALUES (?, ?, ?, 0, now()) ON CONFLICT (user_id, key) DO NOTHING",
            userId, key, route) == 1;
    }

    public Optional<String> recall(long userId, String key) {
        List<String> rows = jdbc.queryForList(
            "SELECT response::text FROM idempotency_keys WHERE user_id = ? AND key = ? AND response IS NOT NULL",
            String.class, userId, key);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public void remember(long userId, String key, int status, String responseJson) {
        jdbc.update("UPDATE idempotency_keys SET status = ?, response = ?::jsonb WHERE user_id = ? AND key = ?",
            status, responseJson, userId, key);
    }
}