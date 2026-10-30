package in.equidron.agents;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;

/** The wired service: budget first, a run row that survives, and steps that make the cost real. */
@SpringBootTest
class AgentServiceIT {

    @Autowired AgentBudget budget;
    @Autowired ToolRegistry tools;
    @Autowired JdbcTemplate jdbc;

    private AgentService service(double budgetUsd) {
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('svc-agent@example.com', 'Svc Agent', 'agent', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        long user = jdbc.queryForObject("SELECT id FROM users WHERE email = 'svc-agent@example.com'", Long.class);
        jdbc.update("INSERT INTO agents (id, name, user_id, model, effort, autonomy_level, enabled, max_steps, daily_budget_usd) " +
            "VALUES ('svc_test', 'Svc Test', ?, 'm', 'low', 1, false, 4, ?) ON CONFLICT (id) DO UPDATE SET daily_budget_usd = EXCLUDED.daily_budget_usd", user, budgetUsd);
        jdbc.update("DELETE FROM agent_runs WHERE agent_id = 'svc_test'");
        AgentLoop.Model fake = (system, prompt) -> new AgentLoop.Completion("ANSWER Order 5 is delivered for asha@example.com", 100, 20, 0.01);
        return new AgentService(budget, tools, fake, jdbc);
    }

    @BeforeEach
    void db() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
    }

    @Test
    void aRunIsRecordedWithItsCostAndAMaskedSummary() {
        Map<String, Object> out = service(1.00).run("svc_test", 3, "manual", "Where is order 5?");
        assertTrue(out.get("answer").toString().contains("delivered"));
        Map<String, Object> run = jdbc.queryForMap("SELECT status, summary, cost_usd FROM agent_runs WHERE agent_id = 'svc_test' ORDER BY id DESC LIMIT 1");
        assertEquals("done", run.get("status"));
        assertEquals(0.01, ((Number) run.get("cost_usd")).doubleValue(), 1e-9);
        assertTrue(run.get("summary").toString().contains("[email]"), "the summary is masked: " + run.get("summary"));
    }

    @Test
    void anExhaustedBudgetStopsTheAgentBeforeTheModelIsCalled() {
        AgentService svc = service(1.00);
        jdbc.update("INSERT INTO agent_runs (agent_id, trigger, status, cost_usd, started_at) VALUES ('svc_test', 't', 'done', 1.00, now())");
        ResponseStatusException e = assertThrows(ResponseStatusException.class, () -> svc.run("svc_test", 3, "manual", "hello"));
        assertEquals(429, e.getStatusCode().value());
        // create() cleared the runs, so exactly the one this test inserted remains - and no new one.
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM agent_runs WHERE agent_id = 'svc_test'", Integer.class),
            "no run row was opened for a refused task");
    }
}