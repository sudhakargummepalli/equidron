package in.equidron.agents;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.util.Set;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;

/** Budgets computed from real run costs, and the gate refusing once they are gone. */
@SpringBootTest
class AgentBudgetIT {

    @Autowired AgentBudget budget;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach
    void anAgentWithABudget() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('budget-agent@example.com', 'Budget Agent', 'agent', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        long user = jdbc.queryForObject("SELECT id FROM users WHERE email = 'budget-agent@example.com'", Long.class);
        jdbc.update("INSERT INTO agents (id, name, user_id, model, effort, autonomy_level, enabled, max_steps, daily_budget_usd) " +
            "VALUES ('budget_test', 'Budget Test', ?, 'm', 'low', 1, false, 3, 1.50) ON CONFLICT (id) DO NOTHING", user);
        jdbc.update("DELETE FROM agent_runs WHERE agent_id = 'budget_test'");
        jdbc.update("INSERT INTO agent_runs (agent_id, trigger, status, cost_usd, started_at) VALUES ('budget_test', 't', 'done', 0.50, now())");
        jdbc.update("INSERT INTO agent_runs (agent_id, trigger, status, cost_usd, started_at) VALUES ('budget_test', 't', 'done', 2.00, now() - interval '2 days')");
    }

    @Test
    void onlyTodaysRunsCountAgainstTodaysBudget() {
        AgentBudget.Budget b = budget.of("budget_test");
        assertEquals(1.50, b.dailyUsd(), 1e-9);
        assertEquals(0.50, b.spentTodayUsd(), 1e-9);
        assertEquals(1.00, b.remainingUsd(), 1e-9, "yesterday's two dollars do not count today");
    }

    @Test
    void reachingTheBudgetIsARefusalBeforeAnyModelIsCalled() {
        jdbc.update("INSERT INTO agent_runs (agent_id, trigger, status, cost_usd, started_at) VALUES ('budget_test', 't', 'done', 1.00, now())");
        AgentBudget.Budget b = budget.of("budget_test");
        assertTrue(b.exhausted());
        assertEquals(0.0, b.remainingUsd(), 1e-9, "never negative");
        ResponseStatusException e = assertThrows(ResponseStatusException.class, () -> budget.require("budget_test"));
        assertEquals(429, e.getStatusCode().value());
    }

    @Test
    void theGateAgreesWithTheBudget() {
        assertFalse(budget.of("budget_test").exhausted());
        assertEquals(PolicyGate.Decision.EXECUTE,
            PolicyGate.decide(PolicyGate.Risk.READ, 5, 0, 0, budget.of("budget_test").remainingUsd(), false));
        jdbc.update("INSERT INTO agent_runs (agent_id, trigger, status, cost_usd, started_at) VALUES ('budget_test', 't', 'done', 1.00, now())");
        double left = budget.of("budget_test").remainingUsd();
        assertEquals(PolicyGate.Decision.DENY, PolicyGate.decide(PolicyGate.Risk.READ, 5, 0, 0, left, false));
    }
}