package in.equidron.agents;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/** Idempotency that survives a restart: the proof is a second registry instance seeing the same key. */
@SpringBootTest
class IdempotencyStoreIT {

    @Autowired IdempotencyStore store;
    @Autowired JdbcTemplate jdbc;

    private long owner;
    private final AtomicInteger calls = new AtomicInteger();

    @BeforeEach
    void anAgentAccount() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('idem-agent@example.com', 'Idem Agent', 'agent', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        owner = jdbc.queryForObject("SELECT id FROM users WHERE email = 'idem-agent@example.com'", Long.class);
        jdbc.update("DELETE FROM idempotency_keys WHERE user_id = ?", owner);
    }

    private ToolRegistry registry() {
        return new ToolRegistry(store, owner).register(new ToolRegistry.Tool(
            "get_order", PolicyGate.Risk.READ, "read", Set.of("a"), 0, in -> { calls.incrementAndGet(); return "{\"id\":1}"; }));
    }

    @Test
    void theSameKeyRunsOnceEvenFromANewRegistryInstance() {
        ToolRegistry.Outcome first = registry().call("a", "get_order", "{}", "idem-1", 5, 10, false);
        assertFalse(first.replayed());
        assertEquals(1, calls.get());

        // A new instance stands in for a restarted process: the answer comes from the database.
        ToolRegistry.Outcome second = registry().call("a", "get_order", "{}", "idem-1", 5, 10, false);
        assertTrue(second.replayed());
        // JSONB comes back re-serialised, so the bytes differ while the meaning does not.
        assertTrue(second.result().contains("id"), second.result());
        assertEquals(1, calls.get(), "the action ran once across both instances");
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM idempotency_keys WHERE user_id = ?", Integer.class, owner));
    }

    @Test
    void aKeyClaimedButUnfinishedIsNotRunAgain() {
        assertTrue(store.claim(owner, "idem-2", "agent:a"));
        assertFalse(store.claim(owner, "idem-2", "agent:a"), "the second claim is refused");
        ToolRegistry.Outcome out = registry().call("a", "get_order", "{}", "idem-2", 5, 10, false);
        assertTrue(out.replayed(), "an unfinished claim is reported, not repeated");
        assertEquals(0, calls.get());
    }
}