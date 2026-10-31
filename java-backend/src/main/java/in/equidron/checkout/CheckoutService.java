package in.equidron.checkout;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Checkout: the one place where money, stock and the cart must all be right at once.
 *
 * Four rules, each of which exists because something goes wrong without it:
 *   1. One transaction. Stock, order, items, payment and the emptied cart commit together, or none do.
 *   2. The offers are locked FOR UPDATE in a stable order before stock is read, so two buyers cannot
 *      both be told the last item is theirs.
 *   3. The caller supplies an idempotency key; the same key returns the same order instead of a
 *      second charge. It is written inside the same transaction as the order.
 *   4. The totals are computed here, in paise, from the prices in the cart rows - the same arithmetic
 *      the cart page showed.
 */
@Service
public class CheckoutService {

    public static final long FREE_SHIPPING_FROM_PAISE = 49900;
    public static final long SHIPPING_PAISE = 4000;

    private final JdbcTemplate jdbc;
    private final in.equidron.notify.OutboxService outbox;
    private final in.equidron.jobs.JobQueue jobs;

    public CheckoutService(JdbcTemplate jdbc, in.equidron.notify.OutboxService outbox, in.equidron.jobs.JobQueue jobs) {
        this.jdbc = jdbc;
        this.outbox = outbox;
        this.jobs = jobs;
    }

    @Transactional
    public Map<String, Object> place(long userId, long addressId, String method, String idempotencyKey) {
        if (!List.of("cod", "upi", "card", "bank", "razorpay").contains(method)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Choose a payment option.");
        }
        if (idempotencyKey == null || idempotencyKey.length() < 8) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "An idempotency key is required.");
        }

        // 1. The same key never creates a second order.
        List<Long> previous = jdbc.queryForList(
            "SELECT (response->>'order_id')::bigint FROM idempotency_keys " +
            "WHERE user_id = ? AND key = ? AND route = 'checkout'",
            Long.class, userId, idempotencyKey);
        if (!previous.isEmpty()) {
            long replayedId = previous.get(0);
            // A key can outlive its order - a cancelled or removed order, or a restored database. Replaying
            // an id that no longer exists hands the customer a 404 for an order they never placed, so a key
            // with no order behind it is discarded and the order is placed again.
            Integer exists = jdbc.queryForObject(
                "SELECT count(*) FROM orders WHERE id = ? AND user_id = ?", Integer.class, replayedId, userId);
            if (exists != null && exists > 0) {
                return Map.of("replayed", true, "order_id", replayedId);
            }
            jdbc.update("DELETE FROM idempotency_keys WHERE user_id = ? AND key = ? AND route = 'checkout'",
                userId, idempotencyKey);
        }

        List<Map<String, Object>> lines = jdbc.queryForList(
            "SELECT c.offer_id, c.qty, c.price_at_add_paise, o.product_id, o.seller_id " +
            "FROM cart_items c JOIN offers o ON o.id = c.offer_id " +
            "WHERE c.user_id = ? ORDER BY c.offer_id", userId);
        if (lines.isEmpty()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Your cart is empty.");

        // 2. Lock the offers, in id order, before reading stock.
        for (Map<String, Object> line : lines) {
            jdbc.queryForList("SELECT id FROM offers WHERE id = ? FOR UPDATE", ((Number) line.get("offer_id")).longValue());
        }

        long subtotal = 0;
        for (Map<String, Object> line : lines) {
            long offerId = ((Number) line.get("offer_id")).longValue();
            int qty = ((Number) line.get("qty")).intValue();
            long price = ((Number) line.get("price_at_add_paise")).longValue();
            Integer stock = jdbc.queryForObject(
                "SELECT COALESCE(SUM(on_hand - reserved), 0) FROM inventory WHERE offer_id = ?", Integer.class, offerId);
            if (stock == null || stock < qty) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "One of the items is no longer available in that quantity.");
            }
            subtotal += price * qty;
        }
        long shipping = subtotal >= FREE_SHIPPING_FROM_PAISE ? 0 : SHIPPING_PAISE;
        long total = subtotal + shipping;
        String address = jdbc.queryForObject("SELECT row_to_json(a)::text FROM addresses a WHERE id = ? AND user_id = ?",
            String.class, addressId, userId);
        if (address == null) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Choose a delivery address.");

        long orderId = jdbc.queryForObject(
            "INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method, " +
            "subtotal_paise, shipping_paise, total_paise, created_at, updated_at) " +
            "VALUES (?, ?::jsonb, 'payment_pending', 'pending', 'unfulfilled', ?, ?, ?, ?, now(), now()) RETURNING id",
            Long.class, userId, address, method, subtotal, shipping, total);

        // The email is written in the same transaction as the order, and sent by a job afterwards: a mail
        // server on a bad morning must not look like a shop that cannot take an order.
        String email = jdbc.queryForObject("SELECT email FROM users WHERE id = ?", String.class, userId);
        outbox.orderConfirmation(userId, email, orderId, total, outbox.languageOf(userId));
        jobs.enqueue("email:deliver", "{\"order_id\":" + orderId + "}", "email:order:" + orderId, 5);

        for (Map<String, Object> line : lines) {
            long offerId = ((Number) line.get("offer_id")).longValue();
            int qty = ((Number) line.get("qty")).intValue();
            long price = ((Number) line.get("price_at_add_paise")).longValue();
            String title = jdbc.queryForObject(
                "SELECT p.title FROM offers o JOIN products p ON p.id = o.product_id WHERE o.id = ?", String.class, offerId);
            jdbc.update("INSERT INTO order_items (order_id, offer_id, product_id, seller_id, warehouse_id, title, qty, unit_price_paise) " +
                        "SELECT ?, o.id, o.product_id, o.seller_id, " +
                        "       (SELECT MIN(i.warehouse_id) FROM inventory i WHERE i.offer_id = o.id), " +
                        "       ?, ?, ? FROM offers o WHERE o.id = ?",
                orderId, title, qty, price, offerId);
            // Reserve the stock: on_hand stays, reserved rises, so both figures stay true.
            jdbc.update("UPDATE inventory SET reserved = reserved + ? WHERE offer_id = ? AND warehouse_id = (" +
                        "SELECT MIN(warehouse_id) FROM inventory WHERE offer_id = ?)", qty, offerId, offerId);
        }

        jdbc.update("INSERT INTO payments (order_id, method, instrument, status, authorized_paise, captured_paise, created_at, updated_at) " +
                    "VALUES (?, ?, ?, 'pending', 0, 0, now(), now())",
            orderId, method, "cod".equals(method) ? "Cash on delivery" : method.toUpperCase());
        jdbc.update("DELETE FROM cart_items WHERE user_id = ?", userId);

        // The event goes into the same transaction as the order: if the order rolls back, no email
        // is queued for an order that does not exist. The Node job queue reads this table.
        jdbc.update("INSERT INTO events (type, entity, entity_id, payload, created_at) VALUES ('order.placed', 'order', ?, ?::jsonb, now())",
            orderId, "{\"total_paise\":" + total + ",\"payment_method\":\"" + method + "\"}");

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("order_id", orderId);
        response.put("total_paise", total);
        jdbc.update("INSERT INTO idempotency_keys (user_id, key, route, status, response, created_at) " +
                    "VALUES (?, ?, 'checkout', 201, ?::jsonb, now())",
            userId, idempotencyKey, "{\"order_id\":" + orderId + "}");

        Map<String, Object> out = new LinkedHashMap<>(response);
        out.put("replayed", false);
        return out;
    }
}