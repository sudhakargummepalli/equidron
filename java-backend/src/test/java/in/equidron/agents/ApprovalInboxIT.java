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

/** An action the gate refuses is parked, decided once, and never silently lost. */
@SpringBootTest
class ApprovalInboxIT {

    @Autowired ApprovalInbox inbox;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach
    void clear() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("DELETE FROM approvals WHERE agent_id = 'inbox_test'");
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('inbox-agent@example.com', 'Inbox Agent', 'agent', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        long agentUser = jdbc.queryForObject("SELECT id FROM users WHERE email = 'inbox-agent@example.com'", Long.class);
        jdbc.update("INSERT INTO agents (id, name, user_id, model, effort, autonomy_level, enabled, max_steps, daily_budget_usd) " +
            "VALUES ('inbox_test', 'Inbox Test', ?, 'm', 'low', 1, false, 3, 1.00) ON CONFLICT (id) DO NOTHING", agentUser);
    }

    @Test
    void aRefusedActionIsParkedRatherThanDropped() {
        long id = inbox.park("inbox_test", "refund", "{\"order_id\":7}", PolicyGate.Risk.MONEY, 250000,
            "Money above the agent limit", "inbox-k-1");
        assertTrue(id > 0);
        var pending = inbox.pending();
        assertTrue(pending.stream().anyMatch(r -> "inbox_test".equals(r.get("agent_id"))));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM approvals WHERE agent_id = 'inbox_test' AND status = 'pending'", Integer.class));
    }

    @Test
    void approvingHappensOnceAndRecordsWhoDecided() {
        long id = inbox.park("inbox_test", "refund", "{}", PolicyGate.Risk.MONEY, 1000, "r", null);
        var out = inbox.decide(id, true, 1, "checked the order");
        assertEquals("approved", out.get("status"));
        assertEquals(1L, jdbc.queryForObject("SELECT decided_by FROM approvals WHERE id = ?", Long.class, id));
        ResponseStatusException e = assertThrows(ResponseStatusException.class, () -> inbox.decide(id, true, 1, "again"));
        assertEquals(409, e.getStatusCode().value(), "the same request cannot be approved twice");
    }

    @Test
    void theGateAndTheInboxAgreeAboutWhatNeedsAPerson() {
        // A write at L1 is shadowed, money above the limit needs approval: the gate says which.
        assertEquals(PolicyGate.Decision.SHADOW, PolicyGate.decide(PolicyGate.Risk.WRITE, 1, 0, 0, 10, false));
        assertEquals(PolicyGate.Decision.NEEDS_APPROVAL, PolicyGate.decide(PolicyGate.Risk.MONEY, 4, 5000, 1000, 10, false));
        long id = inbox.park("inbox_test", "refund", "{}", PolicyGate.Risk.MONEY, 5000, "above limit", null);
        assertEquals("pending", jdbc.queryForObject("SELECT status FROM approvals WHERE id = ?", String.class, id));
    }
}