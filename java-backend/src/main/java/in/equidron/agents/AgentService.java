package in.equidron.agents;

import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Runs one read-only agent task and records it.
 *
 * The order is deliberate: the budget is checked first, so an exhausted agent never calls a model;
 * the run row is opened before the first step, so a crash leaves a trace rather than a mystery; and
 * every step is written to agent_runs as it happens, which is what makes the cost real.
 */
@Service
public class AgentService {

    private final AgentBudget budget;
    private final ToolRegistry tools;
    private final AgentLoop.Model model;
    private final JdbcTemplate jdbc;

    public AgentService(AgentBudget budget, ToolRegistry tools, AgentLoop.Model model, JdbcTemplate jdbc) {
        this.budget = budget;
        this.tools = tools;
        this.model = model;
        this.jdbc = jdbc;
    }

    public Map<String, Object> run(String agentId, int level, String trigger, String task) {
        AgentBudget.Budget b = budget.require(agentId);
        Long runId = jdbc.queryForObject(
            "INSERT INTO agent_runs (agent_id, trigger, subject, status, input_tokens, output_tokens, cost_usd, started_at) " +
            "VALUES (?, ?, ?, 'running', 0, 0, 0, now()) RETURNING id",
            Long.class, agentId, trigger, Mask.mask(task));

        int[] tokens = new int[2];
        double[] cost = new double[1];
        AgentLoop loop = new AgentLoop(model, tools, step -> {
            tokens[0] += ((Number) step.get("input_tokens")).intValue();
            tokens[1] += ((Number) step.get("output_tokens")).intValue();
            cost[0] += ((Number) step.get("cost_usd")).doubleValue();
        }, 4);

        try {
            String answer = loop.run(agentId, level, b.remainingUsd(), task);
            jdbc.update("UPDATE agent_runs SET status = 'done', summary = ?, input_tokens = ?, output_tokens = ?, " +
                        "cost_usd = ?, finished_at = now() WHERE id = ?",
                Mask.mask(answer), tokens[0], tokens[1], cost[0], runId);
            return Map.of("run_id", runId, "answer", answer, "cost_usd", cost[0]);
        } catch (RuntimeException e) {
            jdbc.update("UPDATE agent_runs SET status = 'error', error = ?, input_tokens = ?, output_tokens = ?, " +
                        "cost_usd = ?, finished_at = now() WHERE id = ?",
                Mask.mask(String.valueOf(e.getMessage())), tokens[0], tokens[1], cost[0], runId);
            throw e instanceof ResponseStatusException rse ? rse
                : new ResponseStatusException(HttpStatus.BAD_GATEWAY, "The agent could not finish: " + e.getMessage());
        }
    }

    public List<Map<String, Object>> recentRuns(String agentId) {
        return jdbc.queryForList(
            "SELECT id, status, trigger, summary, cost_usd, started_at, finished_at FROM agent_runs " +
            "WHERE agent_id = ? ORDER BY id DESC LIMIT 20", agentId);
    }
}