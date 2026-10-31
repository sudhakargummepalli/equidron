package in.equidron.notify;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Emails, written in the language the customer chose, and queued rather than sent on the request.
 *
 * Two things were learned the hard way by other shops, and both are here:
 *
 *  - Sending inside the request makes a slow mail server look like a slow shop. The row goes into the outbox
 *    inside the same transaction as the order, and a job sends it afterwards; if the job dies, the order still
 *    exists and the email is still waiting.
 *  - A bounced address must not stop the queue. Each row carries its own attempt count and last error, so one
 *    address that always fails becomes visible instead of blocking the rest.
 */
@Service
public class OutboxService {

    /** The languages the marketplace writes in. Anything else falls back to English. */
    public static final List<String> LANGUAGES = List.of("en", "hi", "te");

    private final JdbcTemplate jdbc;

    public OutboxService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The language this account reads, or English when it never said. */
    public String languageOf(long userId) {
        List<String> rows = jdbc.queryForList("SELECT language FROM users WHERE id = ?", String.class, userId);
        if (rows.isEmpty() || rows.get(0) == null) return "en";
        String language = rows.get(0).trim().toLowerCase();
        return LANGUAGES.contains(language) ? language : "en";
    }

    /** Queue one email. The body is the finished text; rendering is the caller's job. */
    public long queue(long userId, String toAddress, String subject, String body) {
        return jdbc.queryForObject(
            "INSERT INTO outbox (user_id, channel, to_address, subject, body, at, status, attempts) " +
            "VALUES (?, 'email', ?, ?, ?, now(), 'pending', 0) RETURNING id",
            Long.class, userId, toAddress, subject, body);
    }

    /**
     * The order confirmation, in the customer's language.
     *
     * Numbers and the order id stay as they are in every language - a customer reading Telugu still needs to
     * quote order 36 to a person.
     */
    public long orderConfirmation(long userId, String email, long orderId, long totalPaise, String language) {
        Map<String, String[]> words = new LinkedHashMap<>();
        words.put("en", new String[] {"Your Equidron order", "Order", "Total", "We will write again when it ships."});
        words.put("hi", new String[] {"आपका Equidron ऑर्डर", "ऑर्डर", "कुल", "जब यह भेजा जाएगा तो हम फिर लिखेंगे।"});
        words.put("te", new String[] {"మీ Equidron ఆర్డర్", "ఆర్డర్", "మొత్తం", "ఇది పంపినప్పుడు మళ్ళీ రాస్తాము."});
        String[] w = words.getOrDefault(language, words.get("en"));

        String subject = w[0] + " #" + orderId;
        String body = w[0] + " #" + orderId + "\n\n"
            + w[1] + ": " + orderId + "\n"
            + w[2] + ": " + rupees(totalPaise) + "\n\n"
            + w[3] + "\n\nEquidron\n";
        return queue(userId, email, subject, body);
    }

    private static String rupees(long paise) {
        return "Rs " + (paise / 100) + "." + String.format("%02d", paise % 100);
    }

    /** Claim the next few emails that are ready, oldest first. */
    public List<Map<String, Object>> claim(int limit) {
        return jdbc.queryForList(
            "UPDATE outbox SET status = 'sending', claimed_at = now() " +
            "WHERE id IN (SELECT id FROM outbox WHERE status = 'pending' ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED) " +
            "RETURNING id, to_address, subject, body, attempts", limit);
    }

    public void sent(long id) {
        jdbc.update("UPDATE outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = ?", id);
    }

    /**
     * A failure is recorded and the email comes back later, until it has been tried too often.
     *
     * After five attempts the row is parked as 'failed' with the reason. That is the difference between a
     * queue that retries and a queue that hides a broken address forever.
     */
    public void failed(long id, String error) {
        jdbc.update(
            "UPDATE outbox SET attempts = attempts + 1, last_error = ?, claimed_at = NULL, " +
            "status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END WHERE id = ?",
            error == null ? "unknown error" : error, id);
    }

    public Map<String, Object> stats() {
        return jdbc.queryForMap(
            "SELECT count(*) FILTER (WHERE status = 'pending') AS pending, " +
            "       count(*) FILTER (WHERE status = 'sent') AS sent, " +
            "       count(*) FILTER (WHERE status = 'failed') AS failed, " +
            "       count(*) FILTER (WHERE status = 'sending') AS sending FROM outbox");
    }
}
