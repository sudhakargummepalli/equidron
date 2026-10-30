package in.equidron.settlement;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.web.server.ResponseStatusException;

/**
 * Settlement: what each seller has earned and not yet been paid, and a batch a person must approve.
 *
 * Three rules that shape this class:
 *   1. Building a batch moves no money. It records what someone is about to pay.
 *   2. A balance already inside a pending or approved batch is not offered again, or the same sales
 *      would be paid twice.
 *   3. Approval is a guarded UPDATE on status = 'pending', so two clicks (or two servers) cannot pay
 *      the same batch twice.
 *
 * TCS and TDS are computed here as a draft for a CA to confirm, not as tax advice.
 */
@Repository
public class SettlementRepository {

    public static final double TCS_RATE = 0.005;
    public static final double TDS_RATE = 0.01;

    private final JdbcTemplate jdbc;

    public SettlementRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Each seller's unsettled amount: paid sales minus refunds minus what a batch already holds. */
    public List<Map<String, Object>> balances() {
        return jdbc.queryForList(
            "WITH earned AS (" +
            "  SELECT oi.seller_id, " +
            "         SUM(oi.qty * oi.unit_price_paise) FILTER (WHERE o.status NOT IN ('cancelled','payment_failed')) AS gross " +
            "  FROM order_items oi JOIN orders o ON o.id = oi.order_id " +
            "  GROUP BY oi.seller_id" +
            "), refunded AS (" +
            "  SELECT oi.seller_id, COALESCE(SUM(r.refund_paise), 0) AS refunds " +
            "  FROM returns r JOIN order_items oi ON oi.id = r.order_item_id " +
            "  GROUP BY oi.seller_id" +
            "), batched AS (" +
            "  SELECT l.seller_id, COALESCE(SUM(l.gross_paise), 0) AS in_batches " +
            "  FROM payout_lines l JOIN payout_batches b ON b.id = l.batch_id " +
            "  WHERE b.status IN ('pending','approved') GROUP BY l.seller_id" +
            ") " +
            "SELECT s.id AS seller_id, s.name, s.city, " +
            "       COALESCE(e.gross,0) AS earned_paise, COALESCE(rf.refunds,0) AS refunded_paise, " +
            "       COALESCE(b.in_batches,0) AS in_batches_paise, " +
            "       GREATEST(COALESCE(e.gross,0) - COALESCE(rf.refunds,0) - COALESCE(b.in_batches,0), 0) AS balance_paise " +
            "FROM sellers s LEFT JOIN earned e ON e.seller_id = s.id " +
            "LEFT JOIN refunded rf ON rf.seller_id = s.id " +
            "LEFT JOIN batched b ON b.seller_id = s.id " +
            "ORDER BY balance_paise DESC, s.id");
    }

    /** Records a batch of what is owed, with no money moving. One transaction, or no batch at all. */
    public Map<String, Object> build(long staffUserId, String note) {
        List<Map<String, Object>> owing = balances().stream()
            .filter(row -> ((Number) row.get("balance_paise")).longValue() >= 100)
            .toList();
        if (owing.isEmpty()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Nothing to settle.");

        long gross = 0, tcs = 0, tds = 0, net = 0;
        for (Map<String, Object> row : owing) {
            long amount = ((Number) row.get("balance_paise")).longValue();
            gross += amount;
            tcs += Math.round(amount * TCS_RATE);
            tds += Math.round(amount * TDS_RATE);
            net += amount - Math.round(amount * TCS_RATE) - Math.round(amount * TDS_RATE);
        }

        Long batchId = jdbc.queryForObject(
            "INSERT INTO payout_batches (status, total_paise, note, created_at) VALUES ('pending', ?, ?, now()) RETURNING id",
            Long.class, net, note);
        for (Map<String, Object> row : owing) {
            long amount = ((Number) row.get("balance_paise")).longValue();
            long lineTcs = Math.round(amount * TCS_RATE);
            long lineTds = Math.round(amount * TDS_RATE);
            jdbc.update("INSERT INTO payout_lines (batch_id, seller_id, gross_paise, tcs_paise, tds_paise, net_paise) VALUES (?,?,?,?,?,?)",
                batchId, ((Number) row.get("seller_id")).longValue(), amount, lineTcs, lineTds, amount - lineTcs - lineTds);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("batch_id", batchId);
        out.put("sellers", owing.size());
        out.put("gross_paise", gross);
        out.put("tcs_paise", tcs);
        out.put("tds_paise", tds);
        out.put("net_paise", net);
        return out;
    }

    /** Approve or reject. The guarded UPDATE is what makes "pays exactly once" true. */
    public Map<String, Object> decide(long batchId, boolean approve, long staffUserId, String note) {
        String status = approve ? "approved" : "rejected";
        int changed = jdbc.update(
            "UPDATE payout_batches SET status = ?, decided_by = ?, decided_at = now(), note = COALESCE(?, note) " +
            "WHERE id = ? AND status = 'pending'", status, staffUserId, note, batchId);
        if (changed == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "That batch is not waiting for a decision.");
        }
        return Map.of("batch_id", batchId, "status", status);
    }

    public List<Map<String, Object>> batches() {
        return jdbc.queryForList(
            "SELECT id, status, total_paise, note, created_at, decided_at FROM payout_batches ORDER BY id DESC LIMIT 50");
    }

    public List<Map<String, Object>> lines(long batchId) {
        return jdbc.queryForList(
            "SELECT l.seller_id, s.name, l.gross_paise, l.tcs_paise, l.tds_paise, l.net_paise " +
            "FROM payout_lines l JOIN sellers s ON s.id = l.seller_id WHERE l.batch_id = ? ORDER BY l.net_paise DESC", batchId);
    }
}
