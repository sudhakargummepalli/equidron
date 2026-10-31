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
 * account. The test builds two customers with an order each, so it does not depend on seeded data and
 * can prove that one customer's order is refused for the other.
 */
@SpringBootTest
class TelegramBotIT {

    @Autowired TelegramBot bot;
    @Autowired JdbcTemplate jdbc;

    private long userId;
    private long otherOrderId;
    private final List<String> sent = new ArrayList<>();
    private final TelegramBot.Sender sender = (chatId, text) -> sent.add(text);

    private long customer(String email) {
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES (?, ?, 'customer', 's', 'h', now()) " +
                    "ON CONFLICT (email) DO NOTHING", email, email);
        return jdbc.queryForObject("SELECT id FROM users WHERE email = ?", Long.class, email);
    }

    private long orderFor(long user, String note) {
        return jdbc.queryForObject(
            "INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method, " +
            "subtotal_paise, shipping_paise, total_paise, created_at, updated_at) " +
            "VALUES (?, '{}', 'confirmed', 'captured', 'unfulfilled', 'cod', 10000, 0, 10000, now(), now()) RETURNING id",
            Long.class, user);
    }

    @BeforeEach
    void aCustomerAndAChat() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        userId = customer("bot-owner@example.com");
        long otherId = customer("bot-other@example.com");
        jdbc.update("DELETE FROM telegram_links WHERE chat_id = 999001");
        jdbc.update("DELETE FROM telegram_link_codes WHERE user_id IN (?, ?)", userId, otherId);
        jdbc.update("INSERT INTO telegram_link_codes (user_id, code_hash, expires_at, attempts, created_at) " +
                    "VALUES (?, ?, ?, 0, now())",
            userId, TelegramBot.hash("654321"), System.currentTimeMillis() / 1000.0 + 600);
        otherOrderId = orderFor(otherId, "someone else's");
        orderFor(userId, "mine");
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
    void aLinkedChatSeesItsOwnOrdersOnly() {
        bot.handleUpdate(message("999001", "/start 654321"), sender);
        String reply = bot.handleUpdate(message("999001", "/orders"), sender);
        assertTrue(reply.contains("Your last orders"), reply);
        String other = bot.handleUpdate(message("999001", "/order " + otherOrderId), sender);
        assertTrue(other.contains("could not find order"), "another customer's order must be refused: " + other);
    }

    @Test
    void productsSearchAnswersWithPrices() {
        bot.handleUpdate(message("999001", "/start 654321"), sender);
        jdbc.update("INSERT INTO products (title, brand, category, description, specs, images, return_window_days, status, created_at) " +
                    "VALUES ('Bot Test Phone', 'TestBrand', 'Phones', 'x', '{}', '[]', 7, 'live', now())");
        long productId = jdbc.queryForObject("SELECT id FROM products WHERE title = 'Bot Test Phone' ORDER BY id DESC LIMIT 1", Long.class);
        jdbc.update("INSERT INTO offers (product_id, seller_id, price_paise, mrp_paise, condition, fulfilment, handling_days, status, updated_at) " +
                    "SELECT ?, MIN(id), 24900, 29900, 'new', 'seller', 1, 'active', now() FROM sellers", productId);
        String reply = bot.handleUpdate(message("999001", "/products Bot Test"), sender);
        assertTrue(reply.contains("Products for"), reply);
        assertTrue(reply.contains("Rs "), reply);
    }
}