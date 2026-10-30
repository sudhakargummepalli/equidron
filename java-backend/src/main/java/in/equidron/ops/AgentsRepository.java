package in.equidron.ops;

import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** The agents and their budgets: who may act, how far, and how much they may spend today. */
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

    /** One agent's recent runs, without the masked prompt text a person does not need here. */
    public List<Map<String, Object>> runs(String agentId, int limit) {
        return jdbc.queryForList(
            "SELECT id, trigger, subject, status, input_tokens, output_tokens, cost_usd, started_at, finished_at " +
            "FROM agent_runs WHERE agent_id = ? ORDER BY id DESC LIMIT ?",
            agentId, Math.min(50, Math.max(1, limit)));
    }
}
