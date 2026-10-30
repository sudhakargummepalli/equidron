package in.equidron.agents;

import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * What an agent may still spend today.
 *
 * The number comes from the rows that already record cost - agent_runs.cost_usd - and is compared
 * with the agent's own daily_budget_usd. Nothing is estimated: if a run's cost was written, it counts.
 *
 * A budget that is reached stops the agent before a model is called, which is the only way a budget
 * actually bounds spending.
 */
@Service
public class AgentBudget {

    private final JdbcTemplate jdbc;

    public AgentBudget(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record Budget(String agentId, double dailyUsd, double spentTodayUsd, double remainingUsd) {
        public boolean exhausted() { return remainingUsd <= 0; }
    }

    public Budget of(String agentId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT a.daily_budget_usd, " +
            "       COALESCE((SELECT SUM(r.cost_usd) FROM agent_runs r " +
            "                  WHERE r.agent_id = a.id AND r.started_at >= date_trunc('day', now())), 0) AS spent " +
            "FROM agents a WHERE a.id = ?", agentId);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No such agent: " + agentId);
        double daily = ((Number) rows.get(0).get("daily_budget_usd")).doubleValue();
        double spent = ((Number) rows.get(0).get("spent")).doubleValue();
        return new Budget(agentId, daily, spent, Math.max(0, daily - spent));
    }

    /** Ask before calling a model: an exhausted budget is a refusal, not a warning. */
    public Budget require(String agentId) {
        Budget budget = of(agentId);
        if (budget.exhausted()) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                "Daily budget reached for " + agentId + " (" + budget.spentTodayUsd() + " of " + budget.dailyUsd() + " USD).");
        }
        return budget;
    }
}