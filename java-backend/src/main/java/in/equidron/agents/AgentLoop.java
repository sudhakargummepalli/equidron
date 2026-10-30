package in.equidron.agents;

import java.util.Map;
import java.util.function.Consumer;

/**
 * The read-only agent loop: ask, act through the gate, record, stop.
 *
 * Deliberately small. The loop may call only READ tools - anything else is refused here as well as by
 * the gate, so a mistake in a profile cannot turn a support agent into one that refunds. Every step is
 * recorded, every text is masked, and the loop stops at max_steps instead of wandering.
 */
public final class AgentLoop {

    public interface Model {
        Completion complete(String system, String user);
    }

    public record Completion(String text, int inputTokens, int outputTokens, double costUsd) {}

    private static final String SYSTEM = """
        You are a read-only support agent. Answer using tools only.
        Reply with one line: TOOL <name> <json-input>   or   ANSWER <text>.
        Never invent an order id, an amount or a customer name.
        """;

    private final Model model;
    private final ToolRegistry registry;
    private final Consumer<Map<String, Object>> record;
    private final int maxSteps;

    public AgentLoop(Model model, ToolRegistry registry, Consumer<Map<String, Object>> record, int maxSteps) {
        this.model = model;
        this.registry = registry;
        this.record = record;
        this.maxSteps = Math.max(1, maxSteps);
    }

    public String run(String agentId, int level, double budgetLeftUsd, String task) {
        String answer = null;
        for (int step = 1; step <= maxSteps; step++) {
            String prompt = answer == null ? task : task + "\n\nTool result: " + answer;
            Completion c = model.complete(SYSTEM, prompt);
            record.accept(Map.of("step", step, "input_tokens", c.inputTokens(), "output_tokens", c.outputTokens(),
                "cost_usd", c.costUsd(), "text", Mask.mask(c.text())));

            String text = c.text() == null ? "" : c.text().trim();
            if (text.startsWith("ANSWER")) return Mask.mask(text.substring(6).trim());
            if (!text.startsWith("TOOL")) return Mask.mask(text);

            String[] parts = text.split("\\s+", 3);
            String tool = parts.length > 1 ? parts[1] : "";
            String input = parts.length > 2 ? parts[2] : "{}";
            ToolRegistry.Outcome out = registry.call(agentId, tool, input, agentId + ":" + step, level, budgetLeftUsd, false);
            if (out.decision() != PolicyGate.Decision.EXECUTE) {
                return "Refused: " + out.decision() + " for " + tool;
            }
            answer = out.result();
        }
        return "Stopped after " + maxSteps + " steps.";
    }
}