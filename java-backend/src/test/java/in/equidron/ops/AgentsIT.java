package in.equidron.ops;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.HttpClientErrorException;

/**
 * The agents list: staff can see budgets and spend, a customer cannot, and the rows reflect the
 * agents table rather than a hardcoded list.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class AgentsIT {

    @Autowired TestRestTemplate http;
    @Autowired JdbcTemplate jdbc;
    @Autowired SessionService sessions;
    @Autowired UserRepository users;

    private String staffCookie;

    @BeforeEach
    void staffAccount() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('agents-staff@example.com', 'Agents Staff', 'ops', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        long id = jdbc.queryForObject("SELECT id FROM users WHERE email = 'agents-staff@example.com'", Long.class);
        staffCookie = "equidron_session=" + sessions.create(users.byId(id));

        // Two agents of this test's own, so the assertion does not depend on what else is seeded.
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) " +
            "VALUES ('test_reader@agents.invalid', 'Test Reader', 'agent', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        long agentUser = jdbc.queryForObject("SELECT id FROM users WHERE email = 'test_reader@agents.invalid'", Long.class);
        jdbc.update("INSERT INTO agents (id, name, user_id, model, effort, autonomy_level, enabled, max_steps, daily_budget_usd) " +
            "VALUES ('test_reader', 'Test Reader', ?, 'test-model', 'low', 1, false, 4, 1.50) ON CONFLICT (id) DO NOTHING", agentUser);
        jdbc.update("INSERT INTO agent_runs (agent_id, trigger, status, input_tokens, output_tokens, cost_usd, started_at) " +
            "VALUES ('test_reader', 'test', 'done', 100, 20, 0.25, now())");
    }

    private HttpHeaders headers() {
        HttpHeaders h = new HttpHeaders();
        h.add(HttpHeaders.COOKIE, staffCookie);
        return h;
    }

    @Test
    void staffSeeBudgetsAndTodaysSpend() {
        String body = new org.springframework.web.client.RestTemplate().exchange(
            http.getRootUri() + "/api/ops/agents", HttpMethod.GET, new HttpEntity<>(headers()), String.class).getBody();
        assertTrue(body.contains("test_reader"), body);
        assertTrue(body.contains("daily_budget_usd"), body);
        assertTrue(body.contains("spent_today_usd"), body);
        assertTrue(body.contains("1.5") || body.contains("1.50"), "the budget is the stored value: " + body);
    }

    @Test
    void theRunsOfOneAgentAreReadable() {
        String body = new org.springframework.web.client.RestTemplate().exchange(
            http.getRootUri() + "/api/ops/agents/test_reader/runs", HttpMethod.GET, new HttpEntity<>(headers()), String.class).getBody();
        assertTrue(body.contains("input_tokens"), body);
        assertTrue(body.contains("0.25"), body);
    }

    @Test
    void aCustomerIsRefused() {
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('agents-customer@example.com', 'Agents Customer', 'customer', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        long id = jdbc.queryForObject("SELECT id FROM users WHERE email = 'agents-customer@example.com'", Long.class);
        HttpHeaders h = new HttpHeaders();
        h.add(HttpHeaders.COOKIE, "equidron_session=" + sessions.create(users.byId(id)));
        HttpClientErrorException e = assertThrows(HttpClientErrorException.class, () ->
            new org.springframework.web.client.RestTemplate().exchange(
                http.getRootUri() + "/api/ops/agents", HttpMethod.GET, new HttpEntity<>(h), String.class));
        assertEquals(403, e.getStatusCode().value());
    }

    @Test
    void thereIsNoEndpointThatTurnsAnAgentOnOrRaisesABudget() {
        // The slice is read-only on purpose; this test is the statement of that rule.
        HttpClientErrorException e = assertThrows(HttpClientErrorException.class, () ->
            new org.springframework.web.client.RestTemplate().exchange(
                http.getRootUri() + "/api/ops/agents/test_reader", HttpMethod.POST,
                new HttpEntity<>("{\"enabled\":true,\"daily_budget_usd\":99}", headers()), String.class));
        assertTrue(e.getStatusCode().value() >= 400, "no such endpoint");
        assertEquals(false, jdbc.queryForObject("SELECT enabled FROM agents WHERE id = 'test_reader'", Boolean.class));
        assertEquals(1.5, jdbc.queryForObject("SELECT daily_budget_usd FROM agents WHERE id = 'test_reader'", Double.class));
    }
}