package in.equidron.ops;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** The agents, what level means, whether they are paused, and what they have cost today. */
@Repository
public class AgentsRepository {

    private final JdbcTemplate jdbc;

    public AgentsRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<Map<String, Object>> list() {
        return jdbc.queryForList(
            "SELECT a.id, a.name, a.model, a.effort, a.autonomy_level, a.enabled, " +
            "       a.max_steps, a.daily_budget_usd, " +
            "       (SELECT COUNT(*) FROM agent_runs r WHERE r.agent_id = a.id) AS runs, " +
            "       (SELECT COALESCE(SUM(r.cost_usd), 0) FROM agent_runs r " +
            "         WHERE r.agent_id = a.id AND r.started_at >= date_trunc('day', now())) AS spent_today_usd " +
            "FROM agents a ORDER BY a.id");
    }

    /** The kill switch, read from the setting a person flipped. */
    public boolean paused() {
        List<String> rows = jdbc.queryForList(
            "SELECT value::text FROM settings WHERE key = 'agents_paused'", String.class);
        return !rows.isEmpty() && rows.get(0).contains("true");
    }

    /** What each autonomy level means, so the panel can label the control. */
    public Map<String, String> levelNames() {
        Map<String, String> levels = new LinkedHashMap<>();
        levels.put("1", "Observe and suggest only");
        levels.put("2", "Act on routine work, report each step");
        levels.put("3", "Act; money above its limit waits for approval");
        levels.put("4", "Act; money up to its own limit without approval");
        levels.put("5", "Act freely, approvals only for irreversible work");
        return levels;
    }

    public double spentToday() {
        Double spent = jdbc.queryForObject(
            "SELECT COALESCE(SUM(cost_usd), 0) FROM agent_runs WHERE started_at >= date_trunc('day', now())", Double.class);
        return spent == null ? 0 : spent;
    }

    public List<Map<String, Object>> runs(String agentId, int limit) {
        return jdbc.queryForList(
            "SELECT id, trigger, subject, status, input_tokens, output_tokens, cost_usd, started_at, finished_at " +
            "FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT ?",
            agentId, Math.min(50, Math.max(1, limit)));
    }
}