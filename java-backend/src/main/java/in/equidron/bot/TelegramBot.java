package in.equidron.bot;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * The Telegram bot: link an account, then ask about your own orders.
 *
 * Two rules worth stating. The link code is matched by its hash, so the table never holds a usable code.
 * And every command reads only rows belonging to the chat's linked account - a bot that answers about
 * someone else's order because an id was guessed is worse than no bot.
 *
 * Locally there is no public URL for Telegram to call, so this polls getUpdates rather than running a
 * webhook. The update handler takes a sender, so it can be tested without touching the network.
 */
@Service
public class TelegramBot {

    private static final Logger log = LoggerFactory.getLogger(TelegramBot.class);
    private static final int MAX_REPLY = 3800;

    private final JdbcTemplate jdbc;
    private final String token;
    private final boolean pollingEnabled;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    public TelegramBot(JdbcTemplate jdbc,
                       @Value("${TELEGRAM_BOT_TOKEN:}") String token,
                       @Value("${TELEGRAM_POLLING:false}") boolean pollingEnabled) {
        this.jdbc = jdbc;
        this.token = token;
        this.pollingEnabled = pollingEnabled;
    }

    public boolean configured() {
        return token != null && !token.isBlank();
    }

    /** The code the website shows is matched by sha256, exactly as the Node implementation stores it. */
    public static String hash(String code) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(String.valueOf(code).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 is required", e);
        }
    }

    public interface Sender {
        void send(long chatId, String text);
    }

    /** One update, as Telegram sends it. Returns the reply it produced, or null when it stays quiet. */
    public String handleUpdate(Map<String, Object> update, Sender sender) {
        Object messageObj = update.get("message");
        if (!(messageObj instanceof Map<?, ?> message)) return null;
        Object chatObj = message.get("chat");
        if (!(chatObj instanceof Map<?, ?> chat)) return null;
        long chatId = ((Number) chat.get("id")).longValue();
        Object textValue = message.get("text");
        String text = textValue == null ? "" : String.valueOf(textValue).trim();
        if (text.isEmpty()) return null;

        String command = text.split("\\s+")[0].toLowerCase();
        String argument = text.length() > command.length() ? text.substring(command.length()).trim() : "";
        Long userId = linkedUser(chatId);

        String reply;
        if (command.equals("/start")) {
            reply = argument.isEmpty()
                ? (userId == null ? "Hello. Open the marketplace, choose Connect Telegram and send me the code."
                                  : "This chat is already linked. Send /orders or /products.")
                : link(chatId, argument);
        } else if (command.equals("/help")) {
            reply = "/start <code> links this chat\n/orders shows your recent orders\n/order <id> shows one order"
                + "\n/products <word> searches the catalogue\n/unlink disconnects this chat";
        } else if (userId == null) {
            reply = "This chat is not linked yet. Open the marketplace, choose Connect Telegram and send me the code.";
        } else if (command.equals("/unlink")) {
            jdbc.update("DELETE FROM telegram_links WHERE chat_id = ?", chatId);
            reply = "This chat is no longer linked.";
        } else if (command.equals("/orders")) {
            reply = orders(userId);
        } else if (command.equals("/order")) {
            reply = order(userId, argument);
        } else if (command.equals("/products")) {
            reply = products(argument);
        } else {
            reply = "I did not understand that. Send /help.";
        }
        if (reply != null && reply.length() > MAX_REPLY) reply = reply.substring(0, MAX_REPLY);
        sender.send(chatId, reply);
        return reply;
    }

    private Long linkedUser(long chatId) {
        List<Long> rows = jdbc.queryForList("SELECT user_id FROM telegram_links WHERE chat_id = ?", Long.class, chatId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private String link(long chatId, String code) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT user_id FROM telegram_link_codes WHERE code_hash = ? AND expires_at > ?",
            hash(code), System.currentTimeMillis() / 1000.0);
        if (rows.isEmpty()) return "That code is not right or has expired. Ask the website for a new one.";
        long userId = ((Number) rows.get(0).get("user_id")).longValue();
        String role = jdbc.queryForObject("SELECT role FROM users WHERE id = ?", String.class, userId);
        jdbc.update("INSERT INTO telegram_links (chat_id, user_id, role, linked_at, last_seen_at) " +
                    "VALUES (?, ?, ?, now(), now()) ON CONFLICT (chat_id) DO UPDATE SET user_id = EXCLUDED.user_id, " +
                    "role = EXCLUDED.role, linked_at = now()", chatId, userId, role);
        jdbc.update("DELETE FROM telegram_link_codes WHERE user_id = ?", userId);
        return "Linked. Send /orders to see your orders, or /products <word> to search.";
    }

    private String orders(long userId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT id, status, total_paise FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 5", userId);
        if (rows.isEmpty()) return "You have no orders yet.";
        StringBuilder out = new StringBuilder("Your last orders:\n");
        for (Map<String, Object> row : rows) {
            out.append("#").append(row.get("id")).append(" · ").append(row.get("status"))
               .append(" · Rs ").append(((Number) row.get("total_paise")).longValue() / 100).append("\n");
        }
        return out.append("\nSend /order <id> for one of them.").toString();
    }

    private String order(long userId, String argument) {
        try {
            long id = Long.parseLong(argument.replaceAll("[^0-9]", ""));
            List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT id, status, payment_status, total_paise FROM orders WHERE id = ? AND user_id = ?", id, userId);
            if (rows.isEmpty()) return "I could not find order " + id + " on your account. Send /orders to see them.";
            Map<String, Object> row = rows.get(0);
            return "Order #" + id + "\nStatus: " + row.get("status") + "\nPayment: " + row.get("payment_status")
                + "\nTotal: Rs " + (((Number) row.get("total_paise")).longValue() / 100);
        } catch (NumberFormatException e) {
            return "Send the order number, for example: /order 12";
        }
    }

    private String products(String argument) {
        if (argument.isBlank()) return "Send a word to search for, for example: /products phone";
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT p.title, MIN(o.price_paise) AS price FROM products p JOIN offers o ON o.product_id = p.id " +
            "AND o.status = 'active' WHERE p.status = 'live' AND p.title ILIKE ? GROUP BY p.title " +
            "ORDER BY MIN(o.price_paise) LIMIT 5", "%" + argument + "%");
        if (rows.isEmpty()) return "Nothing matched \"" + argument + "\".";
        StringBuilder out = new StringBuilder("Products for \"" + argument + "\":\n");
        for (Map<String, Object> row : rows) {
            out.append(row.get("title")).append(" · Rs ").append(((Number) row.get("price")).longValue() / 100).append("\n");
        }
        return out.toString();
    }

    /** Telegram sends its own header, so a webhook refuses anything without the shared secret. */
    public boolean secretMatches(String given, String expected) {
        if (given == null || expected == null) return false;
        return MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8), expected.getBytes(StandardCharsets.UTF_8));
    }

    public Sender httpSender() {
        return (chatId, text) -> {
            if (!configured()) return;
            String body = "{\"chat_id\":" + chatId + ",\"text\":" + quote(text) + "}";
            try {
                http.send(HttpRequest.newBuilder(URI.create("https://api.telegram.org/bot" + token + "/sendMessage"))
                    .timeout(Duration.ofSeconds(15)).header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
            } catch (Exception e) {
                log.warn("telegram send failed: {}", e.getMessage());
            }
        };
    }

    private static String quote(String text) {
        return "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
    }

    /** Long polling, because Telegram cannot reach a local server. Off unless TELEGRAM_POLLING=true. */
    @EventListener(ApplicationReadyEvent.class)
    public void startPolling() {
        if (!configured() || !pollingEnabled) return;
        Thread thread = new Thread(() -> {
            long offset = 0;
            Sender sender = httpSender();
            while (true) {
                try {
                    String url = "https://api.telegram.org/bot" + token + "/getUpdates?timeout=25&offset=" + offset;
                    HttpResponse<String> response = http.send(HttpRequest.newBuilder(URI.create(url))
                        .timeout(Duration.ofSeconds(40)).GET().build(), HttpResponse.BodyHandlers.ofString());
                    for (Map<String, Object> update : parseUpdates(response.body())) {
                        Object id = update.get("update_id");
                        if (id instanceof Number n) offset = n.longValue() + 1;
                        handleUpdate(update, sender);
                    }
                } catch (Exception e) {
                    log.warn("telegram polling: {}", e.getMessage());
                    try { Thread.sleep(3000); } catch (InterruptedException interrupted) { return; }
                }
            }
        }, "telegram-poll");
        thread.setDaemon(true);
        thread.start();
        log.info("telegram polling started");
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> parseUpdates(String body) throws Exception {
        Object parsed = new com.fasterxml.jackson.databind.ObjectMapper().readValue(body, Object.class);
        if (!(parsed instanceof Map<?, ?> map)) return List.of();
        Object result = map.get("result");
        return result instanceof List<?> list ? (List<Map<String, Object>>) list : List.of();
    }
}