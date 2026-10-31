package in.equidron.shop;

import in.equidron.agents.AgentBudget;
import in.equidron.agents.AgentLoop;
import in.equidron.agents.Mask;
import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * The customer's assistant: questions about products, delivery and the customer's own orders.
 *
 * Two decisions make this safe, and both are about what the model is not allowed to reach:
 *
 *  - It gets no tools. The tool registry would let it read any order by id, and one customer must never be
 *    able to reach another's order by asking politely. Instead the customer's own orders are read here, by
 *    their session, and only the answers are handed to the model.
 *  - It is capped and recorded. Every question costs money, so each account has a daily allowance, each
 *    answer is written to agent_runs with its cost, and a question longer than a paragraph is refused rather
 *    than paid for.
 */
@RestController
public class ShopAssistantController {

    /** How many questions one account may ask in a day, and how long a question may be. */
    private static final int DAILY_QUESTIONS = 30;
    private static final int MAX_QUESTION = 500;

    private final JdbcTemplate jdbc;
    private final SessionService session;
    private final UserRepository users;
    private final AgentLoop.Model model;
    private final AgentBudget budget;

    public ShopAssistantController(JdbcTemplate jdbc, SessionService session, UserRepository users,
                                   AgentLoop.Model model, AgentBudget budget) {
        this.jdbc = jdbc;
        this.session = session;
        this.users = users;
        this.model = model;
        this.budget = budget;
    }

    /** The chat panel asks this before showing itself. */
    @GetMapping("/api/shop/assistant")
    public Map<String, Object> available() {
        boolean key = System.getenv("DEEPSEEK_API_KEY") != null && !System.getenv("DEEPSEEK_API_KEY").isBlank();
        return Map.of("available", key, "questions_left_today", DAILY_QUESTIONS);
    }

    @PostMapping("/api/shop/assistant")
    public Map<String, Object> ask(@CookieValue(name = "equidron_session", required = false) String token,
                                   @RequestBody Map<String, Object> body) {
        UserRepository.User user = token == null ? null : session.resolve(token, users);
        if (user == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Please sign in to ask.");
        long userId = user.id();
        String question = lastQuestion(body);
        if (question.length() < 2) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Ask a question.");
        if (question.length() > MAX_QUESTION) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Please keep the question shorter.");
        }

        Integer asked = jdbc.queryForObject(
            "SELECT count(*) FROM agent_runs WHERE agent_id = 'support' AND trigger = 'customer' " +
            "AND subject LIKE ? AND started_at >= date_trunc('day', now())",
            Integer.class, "%" + userId + "%");
        if (asked != null && asked >= DAILY_QUESTIONS) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                "That is enough questions for today. A person can help you from Customer service.");
        }

        AgentBudget.Budget b = budget.require("support");
        if (b.remainingUsd() <= 0) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "The assistant has reached its budget for today. A person can help you from Customer service.");
        }

        String answer;
        try {
            AgentLoop.Completion done = model.complete(system(), user(userId, question));
            answer = done.text();
            jdbc.update(
                "INSERT INTO agent_runs (agent_id, trigger, subject, status, summary, input_tokens, output_tokens, " +
                "cost_usd, started_at, finished_at) VALUES ('support', 'customer', ?, 'done', ?, ?, ?, ?, now(), now())",
                "customer:" + userId + " - " + Mask.mask(question),
                Mask.mask(answer), done.inputTokens(), done.outputTokens(), done.costUsd());
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "The assistant is unavailable right now. A person can help you from Customer service.");
        }

        return Map.of("reply", answer,
                      "products", productsFor(question),
                      "questions_left_today", Math.max(0, DAILY_QUESTIONS - (asked == null ? 0 : asked) - 1));
    }

    /** The conversation arrives as messages; the last thing the customer said is the question. */
    private static String lastQuestion(Map<String, Object> body) {
        Object messages = body.get("messages");
        if (messages instanceof List<?> list && !list.isEmpty()) {
            Object last = list.get(list.size() - 1);
            if (last instanceof Map<?, ?> m && m.get("content") != null) return String.valueOf(m.get("content")).trim();
        }
        return String.valueOf(body.getOrDefault("question", "")).trim();
    }

    /**
     * Products worth showing under the reply.
     *
     * The words matter, but so does the limit: a customer asking for a case "under 500" must not be shown a
     * one-lakh phone just because its title contains "phone". The number in the question is a filter, not
     * decoration.
     */
    private List<Map<String, Object>> productsFor(String question) {
        String lower = question.toLowerCase();
        Long maxPaise = null;
        var m = java.util.regex.Pattern.compile("(?:under|below|less than|upto|up to|within)\\s*(?:rs\\.?|inr|\\u20b9)?\\s*([0-9][0-9,]*)(k)?").matcher(lower);
        if (m.find()) {
            long amount = Long.parseLong(m.group(1).replace(",", ""));
            if (m.group(2) != null) amount *= 1000;
            maxPaise = amount * 100;
        }

        String[] words = lower.replaceAll("[^a-z0-9 ]", " ").split("\\s+");
        java.util.List<String> terms = new java.util.ArrayList<>();
        for (String w : words) {
            if (w.length() >= 5 && !w.matches("\\d+")) terms.add(w);
        }
        terms.sort((a, b) -> b.length() - a.length());

        for (String word : terms) {
            String sql = "SELECT p.id, p.title, p.brand, p.images->>0 AS image, MIN(o.price_paise) AS price_paise " +
                "FROM products p JOIN offers o ON o.product_id = p.id AND o.status = 'active' " +
                "WHERE p.status = 'live' AND (p.title ILIKE ? OR p.brand ILIKE ? OR p.category ILIKE ?) " +
                (maxPaise == null ? "" : "AND o.price_paise <= " + maxPaise + " ") +
                "GROUP BY p.id, p.title, p.brand, p.images ORDER BY price_paise LIMIT 3";
            List<Map<String, Object>> found = jdbc.queryForList(sql, "%" + word + "%", "%" + word + "%", "%" + word + "%");
            if (!found.isEmpty()) return found;
        }
        return List.of();
    }

    private String system() {
        return """
            You are the Equidron store assistant. Answer in two or three short sentences, in the customer's
            language if they wrote in another one. Use only the facts below; if something is not there, say
            that a person from Customer service will help and do not guess.
            Rules: never promise a date you were not given; never invent a price, a discount or a policy; never
            ask for card, bank or password details; never mention internal notes, agents or staff.
            Delivery: free over 499 rupees, otherwise 40 rupees. Returns: 10 days after delivery for most
            items, and the item must be unused. Payments: cards, UPI, net banking and cash on delivery.
            """;
    }

    /** The catalogue in front of the customer, and their own orders - nothing else. */
    private String user(long userId, String question) {
        List<Map<String, Object>> products = jdbc.queryForList(
            "SELECT p.title, p.brand, p.category, MIN(o.price_paise) AS price_paise, " +
            "       COALESCE(SUM(i.on_hand - i.reserved), 0) AS in_stock " +
            "FROM products p JOIN offers o ON o.product_id = p.id AND o.status = 'active' " +
            "LEFT JOIN inventory i ON i.offer_id = o.id " +
            "WHERE p.status = 'live' GROUP BY p.id, p.title, p.brand, p.category " +
            "ORDER BY price_paise LIMIT 40");

        List<Map<String, Object>> orders = jdbc.queryForList(
            "SELECT o.id, o.status, o.payment_status, o.fulfilment_status, o.total_paise, o.created_at::date AS placed " +
            "FROM orders o WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 5", userId);

        StringBuilder text = new StringBuilder("Catalogue:\n");
        for (Map<String, Object> p : products) {
            text.append("- ").append(p.get("title")).append(" (").append(p.get("brand")).append(", ")
                .append(p.get("category")).append(") at ")
                .append(((Number) p.get("price_paise")).longValue() / 100).append(" rupees, ")
                .append(((Number) p.get("in_stock")).longValue() > 0 ? "in stock" : "out of stock").append('\n');
        }
        text.append("\nThis customer's recent orders:\n");
        if (orders.isEmpty()) text.append("- none yet\n");
        for (Map<String, Object> o : orders) {
            text.append("- order ").append(o.get("id")).append(": ").append(o.get("status"))
                .append(", payment ").append(o.get("payment_status"))
                .append(", delivery ").append(o.get("fulfilment_status"))
                .append(", total ").append(((Number) o.get("total_paise")).longValue() / 100)
                .append(" rupees, placed ").append(o.get("placed")).append('\n');
        }
        text.append("\nCustomer's question: ").append(question);
        return text.toString();
    }
}
