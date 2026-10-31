package in.equidron.support;

import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import in.equidron.cart.SessionUser;
import java.security.SecureRandom;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * The Telegram link card: a short code a person sends to the bot to connect their account.
 *
 * Stored hashed with an expiry, like every other one-time code. When no bot is configured the route says
 * so plainly instead of returning a 404, because the page treats a missing route as a broken panel.
 */
@RestController
public class TelegramLinkController {

    private final JdbcTemplate jdbc;
    private final SessionUser session;
    private final SessionService sessions;
    private final UserRepository users;
    private final String botUsername;
    private final SecureRandom random = new SecureRandom();

    public TelegramLinkController(JdbcTemplate jdbc, SessionUser session, SessionService sessions,
                                  UserRepository users, @Value("${TELEGRAM_BOT_USERNAME:}") String botUsername) {
        this.jdbc = jdbc;
        this.session = session;
        this.sessions = sessions;
        this.users = users;
        this.botUsername = botUsername;
    }

    @PostMapping({"/api/shop/telegram/link-code", "/api/seller/telegram/link-code"})
    public Map<String, Object> code(@CookieValue(name = "equidron_session", required = false) String token) {
        long userId = session.require(token);
        if (botUsername == null || botUsername.isBlank()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Telegram is not configured on this marketplace yet.");
        }
        String code = String.format("%06d", random.nextInt(1_000_000));
        jdbc.update("INSERT INTO telegram_link_codes (user_id, code_hash, expires_at, attempts, created_at) " +
                    "VALUES (?, ?, ?, 0, now()) ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, " +
                    "expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()",
            userId, in.equidron.bot.TelegramBot.hash(code),
            System.currentTimeMillis() / 1000.0 + 15 * 60);
        return Map.of("code", code, "bot", "@" + botUsername.replace("@", ""),
            "expires_in_minutes", 15);
    }
}