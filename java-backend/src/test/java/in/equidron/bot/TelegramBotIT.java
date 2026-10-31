package in.equidron.bot;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The bot against real rows: a code links a chat to one account, and every command answers only for that
 * account. The sender is captured rather than sent, so no network is involved.
 */
@SpringBootTest
class TelegramBotIT {

    @Autowired TelegramBot bot;
    @Autowired JdbcTemplate jdbc;

    private long userId;
    private final List<String> sent = new ArrayList<>();
    private final TelegramBot.Sender sender = (chatId, text) -> sent.add(text);

    @BeforeEach
    void aCustomerAndAChat() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        userId = jdbc.queryForObject("SELECT id FROM users WHERE email = 'asha@example.com'", Long.class);
        jdbc.update("DELETE FROM telegram_links WHERE chat_id = 999001");
        jdbc.update("DELETE FROM telegram_link_codes WHERE user_id = ?", userId);
        jdbc.update("INSERT INTO telegram_link_codes (user_id, code_hash, expires_at, attempts, created_at) " +
                    "VALUES (?, ?, ?, 0, now())",
            userId, TelegramBot.hash("654321"), System.currentTimeMillis() / 1000.0 + 600);
        sent.clear();
    }

    private Map<String, Object> message(String chat, String text) {
        return Map.of("message", Map.of("chat", Map.of("id", Long.parseLong(chat)), "text", text));
    }

    @Test
    void aCodeLinksTheChatToTheAccount() {
        String reply = bot.handleUpdate(message("999001", "/start 654321"), sender);
        assertTrue(reply.startsWith("Linked"), reply);
        assertEquals(userId, jdbc.queryForObject("SELECT user_id FROM telegram_links WHERE chat_id = 999001", Long.class));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM telegram_link_codes WHERE user_id = ?", Integer.class, userId),
            "a used code is deleted, not left for a second try");
        assertEquals(1, sent.size(), "the reply reached the sender");
    }

    @Test
    void aWrongCodeLinksNothing() {
        String reply = bot.handleUpdate(message("999001", "/start 000000"), sender);
        assertTrue(reply.contains("not right or has expired"), reply);
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM telegram_links WHERE chat_id = 999001", Integer.class));
    }

    @Test
    void anUnlinkedChatIsToldHowToLink() {
        String reply = bot.handleUpdate(message("999002", "/orders"), sender);
        assertTrue(reply.contains("not linked yet"), reply);
    }

    @Test
    void aLinkedChatGetsOnlyItsOwnOrders() {
        bot.handleUpdate(message("999001", "/start 654321"), sender);
        String reply = bot.handleUpdate(message("999001", "/orders"), sender);
        assertTrue(reply.contains("Your last orders"), reply);
        String other = bot.handleUpdate(message("999001", "/order 3"), sender);
        assertTrue(other.contains("could not find order 3"), "order 3 belongs to someone else: " + other);
    }

    @Test
    void productsSearchAnswersWithPrices() {
        bot.handleUpdate(message("999001", "/start 654321"), sender);
        String reply = bot.handleUpdate(message("999001", "/products phone"), sender);
        assertTrue(reply.contains("Products for"), reply);
        assertTrue(reply.contains("Rs "), reply);
    }
}