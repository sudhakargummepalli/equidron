package in.equidron.agents;

import static org.junit.jupiter.api.Assertions.*;

import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** The registry's rules, without a database: who may call what, what the gate allows, and once-only. */
class ToolRegistryTest {

    private final AtomicInteger calls = new AtomicInteger();

    private ToolRegistry registry() {
        return new ToolRegistry()
            .register(new ToolRegistry.Tool("get_order", PolicyGate.Risk.READ, "Read an order", Set.of("support"), 0,
                in -> { calls.incrementAndGet(); return "order"; }))
            .register(new ToolRegistry.Tool("refund", PolicyGate.Risk.MONEY, "Refund an order", Set.of("support"), 500,
                in -> { calls.incrementAndGet(); return "refunded"; }))
            .register(new ToolRegistry.Tool("cancel", PolicyGate.Risk.IRREVERSIBLE, "Cancel an order", Set.of("support"), 0,
                in -> { calls.incrementAndGet(); return "cancelled"; }));
    }

    @Test
    void aToolThatChangesSomethingMustDescribeItselfAndNamesAreUnique() {
        assertThrows(IllegalArgumentException.class, () -> new ToolRegistry()
            .register(new ToolRegistry.Tool("x", PolicyGate.Risk.WRITE, "", Set.of("a"), 0, in -> "{}")));
        assertThrows(IllegalArgumentException.class, () -> registry()
            .register(new ToolRegistry.Tool("refund", PolicyGate.Risk.MONEY, "d", Set.of("support"), 0, in -> "{}")));
    }

    @Test
    void anAgentMayOnlyCallToolsItOwns() {
        ToolRegistry r = registry();
        assertEquals(3, r.forAgent("support").size());
        assertEquals(0, r.forAgent("seller").size());
        assertThrows(IllegalStateException.class, () -> r.call("seller", "refund", "{}", null, 5, 10, false));
    }

    @Test
    void aReadRunsAndMoneyBelowItsLevelDoesNot() {
        ToolRegistry r = registry();
        assertEquals(PolicyGate.Decision.EXECUTE, r.call("support", "get_order", "{}", null, 1, 10, false).decision());
        assertEquals(1, calls.get());
        ToolRegistry.Outcome gated = r.call("support", "refund", "{}", null, 1, 10, false);
        assertEquals(PolicyGate.Decision.NEEDS_APPROVAL, gated.decision());
        assertNull(gated.result(), "the action must not run");
        assertEquals(1, calls.get());
    }

    @Test
    void moneyInsideTheLimitRunsAndIrreversibleNeverDoesAlone() {
        ToolRegistry r = registry();
        assertEquals(PolicyGate.Decision.EXECUTE, r.call("support", "refund", "{}", null, 4, 10, false).decision());
        assertEquals(PolicyGate.Decision.NEEDS_APPROVAL, r.call("support", "cancel", "{}", null, 5, 10, false).decision());
        assertEquals(1, calls.get(), "only the refund reached the action; the cancel never did");
    }

    @Test
    void theSameIdempotencyKeyRunsOnceAndReplays() {
        ToolRegistry r = registry();
        ToolRegistry.Outcome first = r.call("support", "get_order", "{}", "k-1", 5, 10, false);
        ToolRegistry.Outcome second = r.call("support", "get_order", "{}", "k-1", 5, 10, false);
        assertEquals(1, calls.get());
        assertEquals(first.result(), second.result());
        assertFalse(first.replayed());
        assertTrue(second.replayed());
    }

    @Test
    void noBudgetOrPausedMeansNoExecution() {
        ToolRegistry r = registry();
        assertEquals(PolicyGate.Decision.DENY, r.call("support", "get_order", "{}", null, 5, 0, false).decision());
        assertEquals(PolicyGate.Decision.DENY, r.call("support", "get_order", "{}", null, 5, 10, true).decision());
        assertEquals(0, calls.get());
    }
}