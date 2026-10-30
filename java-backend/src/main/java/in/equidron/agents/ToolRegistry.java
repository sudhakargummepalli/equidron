package in.equidron.agents;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The tool registry: the only way an agent changes anything.
 *
 * A tool declares its own risk, the agents allowed to call it, and - for money - its own automatic
 * limit. The registry refuses a tool the agent may not use, asks the gate what to do, runs the action
 * only when the gate says EXECUTE, and runs it at most once per idempotency key.
 *
 * The idempotency record is in memory for now; the next step moves it to the idempotency_keys table so
 * a retry after a restart is still recognised. This comment exists so nobody assumes otherwise.
 */
public final class ToolRegistry {

    public interface Action {
        String run(String inputJson) throws Exception;
    }

    public record Tool(String name, PolicyGate.Risk risk, String description, Set<String> agents,
                       long autoLimitPaise, Action action) {}

    public record Outcome(PolicyGate.Decision decision, String result, boolean replayed) {}

    private final Map<String, Tool> tools = new LinkedHashMap<>();
    private final Map<String, String> idempotency = new ConcurrentHashMap<>();
    private final IdempotencyStore store;
    private final long ownerUserId;

    public ToolRegistry() { this(null, 0); }

    public ToolRegistry(IdempotencyStore store, long ownerUserId) {
        this.store = store;
        this.ownerUserId = ownerUserId;
    }

    public ToolRegistry register(Tool tool) {
        if (tools.containsKey(tool.name())) throw new IllegalArgumentException("A tool named " + tool.name() + " already exists.");
        if (tool.risk() != PolicyGate.Risk.READ && (tool.description() == null || tool.description().isBlank())) {
            throw new IllegalArgumentException("A tool that changes something must say what it does: " + tool.name());
        }
        tools.put(tool.name(), tool);
        return this;
    }

    public Optional<Tool> find(String name) {
        return Optional.ofNullable(tools.get(name));
    }

    public List<Tool> forAgent(String agentId) {
        return tools.values().stream().filter(t -> t.agents().contains(agentId)).toList();
    }

    public Outcome call(String agentId, String toolName, String inputJson, String idempotencyKey,
                        int level, double budgetLeftUsd, boolean paused) {
        Tool tool = tools.get(toolName);
        if (tool == null) throw new IllegalArgumentException("No such tool: " + toolName);
        if (!tool.agents().contains(agentId)) throw new IllegalStateException(agentId + " may not use " + toolName);
        PolicyGate.Decision decision = PolicyGate.decide(tool.risk(), level, 0, tool.autoLimitPaise(), budgetLeftUsd, paused);
        if (decision != PolicyGate.Decision.EXECUTE) return new Outcome(decision, null, false);
        if (idempotencyKey != null) {
            if (store != null) {
                java.util.Optional<String> answered = store.recall(ownerUserId, idempotencyKey);
                if (answered.isPresent()) return new Outcome(PolicyGate.Decision.EXECUTE, answered.get(), true);
                // Claim first: two callers with the same key cannot both reach the action.
                if (!store.claim(ownerUserId, idempotencyKey, "agent:" + agentId)) {
                    return new Outcome(PolicyGate.Decision.EXECUTE, "{\"in_progress\":true}", true);
                }
            } else if (idempotency.containsKey(idempotencyKey)) {
                return new Outcome(PolicyGate.Decision.EXECUTE, idempotency.get(idempotencyKey), true);
            }
        }
        try {
            String result = tool.action().run(inputJson == null ? "{}" : inputJson);
            if (idempotencyKey != null) {
                if (store != null) store.remember(ownerUserId, idempotencyKey, 200, result);
                else idempotency.put(idempotencyKey, result);
            }
            return new Outcome(PolicyGate.Decision.EXECUTE, result, false);
        } catch (Exception e) {
            return new Outcome(PolicyGate.Decision.EXECUTE, "Error: " + e.getMessage(), false);
        }
    }
}