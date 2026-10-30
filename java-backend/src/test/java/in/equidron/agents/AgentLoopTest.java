package in.equidron.agents;

import static org.junit.jupiter.api.Assertions.*;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** The loop with a fake model: it asks, acts once, records every step, masks, and stops. */
class AgentLoopTest {

    private final List<Map<String, Object>> steps = new ArrayList<>();

    private ToolRegistry readOnly() {
        return new ToolRegistry().register(new ToolRegistry.Tool("get_order", PolicyGate.Risk.READ, "read", Set.of("support"), 0,
            in -> "status delivered, customer asha@example.com"));
    }

    @Test
    void aToolCallGoesThroughTheGateAndTheAnswerIsMasked() {
        var replies = new java.util.ArrayDeque<>(List.of(
            new AgentLoop.Completion("TOOL get_order {}", 100, 20, 0.01),
            new AgentLoop.Completion("ANSWER Order is delivered", 120, 15, 0.01)));
        AgentLoop loop = new AgentLoop((s, u) -> replies.removeFirst(), readOnly(), steps::add, 4);

        String answer = loop.run("support", 3, 1.0, "Where is order 5?");
        assertEquals("Order is delivered", answer);
        assertEquals(2, steps.size(), "one step per model call");
        assertEquals(0.02, steps.stream().mapToDouble(m -> (Double) m.get("cost_usd")).sum(), 1e-9);
    }

    @Test
    void maskingHappensBeforeAnythingIsRecorded() {
        assertEquals("[email]", Mask.mask("asha@example.com"));
        assertEquals("[card]", Mask.mask("4111111111111111"));
        assertEquals("[secret]", Mask.mask("sk_live_abcdefgh"));
        assertEquals("[phone]", Mask.mask("+91 98765 43210"));
        assertNull(Mask.mask(null));
    }

    @Test
    void aToolTheAgentDoesNotOwnStopsTheLoop() {
        AgentLoop loop = new AgentLoop((s, u) -> new AgentLoop.Completion("TOOL refund {}", 10, 5, 0.0),
            readOnly(), steps::add, 3);
        // A tool that does not exist is refused by the registry; one the agent does not own is refused too.
        assertThrows(IllegalArgumentException.class, () -> loop.run("support", 3, 1.0, "refund please"));
    }

    @Test
    void theLoopStopsAtMaxStepsInsteadOfWandering() {
        AgentLoop loop = new AgentLoop((s, u) -> new AgentLoop.Completion("TOOL get_order {}", 10, 5, 0.0),
            readOnly(), steps::add, 2);
        assertTrue(loop.run("support", 3, 1.0, "loop forever").startsWith("Stopped after 2 steps"));
        assertEquals(2, steps.size());
    }
}