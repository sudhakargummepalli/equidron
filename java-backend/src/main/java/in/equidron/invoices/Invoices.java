package in.equidron.invoices;

import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Issuing an invoice for an order.
 *
 * One transaction, and the numbers come from the order rather than the request. An invoice already
 * issued is returned rather than re-numbered: a customer who downloads twice must not receive two
 * different numbers for the same order.
 */
@Service
public class Invoices {

    private final JdbcTemplate jdbc;

    public Invoices(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional
    public Map<String, Object> issue(long orderId) {
        List<Map<String, Object>> existing = jdbc.queryForList(
            "SELECT number FROM invoices WHERE order_id = ?", orderId);
        if (!existing.isEmpty()) {
            return Map.of("order_id", orderId, "number", existing.get(0).get("number"), "existing", true);
        }

        List<Map<String, Object>> orders = jdbc.queryForList(
            "SELECT total_paise, address->>'state' AS state FROM orders WHERE id = ?", orderId);
        if (orders.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Order not found.");

        long total = ((Number) orders.get(0).get("total_paise")).longValue();
        String state = (String) orders.get(0).get("state");
        boolean interState = state != null && !"Karnataka".equalsIgnoreCase(state);
        InvoiceCalc.Tax tax = InvoiceCalc.splitTax(total, interState);

        String period = jdbc.queryForObject("SELECT to_char(now(), 'YYYYMM')", String.class);
        Integer used = jdbc.queryForObject(
            "SELECT count(*) FROM invoices WHERE number LIKE ?", Integer.class, "INV-" + period + "-%");
        String number = InvoiceCalc.number(period, (used == null ? 0 : used) + 1);

        jdbc.update("INSERT INTO invoices (order_id, number, issued_at, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, place_of_supply) " +
                    "VALUES (?, ?, now(), ?, ?, ?, ?, ?, ?)",
            orderId, number, tax.taxablePaise(), tax.cgstPaise(), tax.sgstPaise(), tax.igstPaise(), total, state);

        return Map.of("order_id", orderId, "number", number, "existing", false, "total_paise", total,
            "taxable_paise", tax.taxablePaise());
    }

    /** One invoice for one owner, with the amounts already written for a page or a PDF. */
    public Map<String, Object> view(long orderId, long userId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT i.number, to_char(i.issued_at, 'DD Month YYYY') AS issued_on, " +
            "       i.taxable_paise, i.cgst_paise, i.sgst_paise, i.igst_paise, i.total_paise " +
            "FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.order_id = ? AND o.user_id = ?",
            orderId, userId);
        if (rows.isEmpty()) return null;
        Map<String, Object> row = new java.util.LinkedHashMap<>(rows.get(0));
        for (String key : new String[] {"taxable", "cgst", "sgst", "igst", "total"}) {
            long paise = ((Number) row.get(key + "_paise")).longValue();
            row.put(key + "_paise_list", String.format(java.util.Locale.ROOT, "%d.%02d", paise / 100, paise % 100));
        }
        return row;
    }
}
