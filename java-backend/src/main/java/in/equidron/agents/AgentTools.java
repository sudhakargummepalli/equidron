package in.equidron.agents;

import java.util.Set;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The tools available to the read-only agent, and the model that drives it.
 *
 * Only READ tools are registered. If DEEPSEEK_API_KEY is absent the model fails closed: a missing key
 * must stop the agent, not silently fall back to something that can do more.
 */
@Configuration
public class AgentTools {

    @Bean
    public ToolRegistry agentToolRegistry(JdbcTemplate jdbc) {
        return new ToolRegistry()
            .register(new ToolRegistry.Tool("get_order", PolicyGate.Risk.READ,
                "Read one order's status and total, by order_id", Set.of("support", "ops_manager"), 0,
                input -> {
                    long id = Long.parseLong(input.replaceAll("[^0-9]", ""));
                    var rows = jdbc.queryForList(
                        "SELECT id, status, payment_status, total_paise FROM orders WHERE id = ?", id);
                    return rows.isEmpty() ? "{\"found\":false}" : String.valueOf(rows.get(0));
                }))
            .register(new ToolRegistry.Tool("list_products", PolicyGate.Risk.READ,
                "List live products, optionally filtered by a word", Set.of("support", "ops_manager"), 0,
                input -> String.valueOf(jdbc.queryForList(
                    "SELECT id, title, brand FROM products WHERE status = 'live' AND title ILIKE ? LIMIT 10",
                    "%" + input.replaceAll("[{}\"a-z ]", "").trim() + "%"))));
    }

    @Bean
    public AgentLoop.Model agentModel() {
        String key = System.getenv("DEEPSEEK_API_KEY");
        if (key == null || key.isBlank()) {
            return (system, user) -> {
                throw new IllegalStateException("DEEPSEEK_API_KEY is not set; the agent model is unavailable.");
            };
        }
        return new DeepSeekModel(key);
    }
}