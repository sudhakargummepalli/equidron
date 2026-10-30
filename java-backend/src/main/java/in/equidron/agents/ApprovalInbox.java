package in.equidron.agents;

import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.web.server.ResponseStatusException;

/**
 * The approval inbox: where a NEEDS_APPROVAL decision waits for a person.
 *
 * A row is written when the gate refuses to act alone, so the action is not lost - it is parked with
 * the agent, the tool, the payload and the amount, and stays visible until someone decides.
 *
 * Two rules: the decision is a guarded UPDATE on status = 'pending' (so two staff cannot both approve
 * and execute), and the deciding user is recorded (so "who allowed this" has an answer).
 */
@Repository
public class ApprovalInbox {

    private final JdbcTemplate jdbc;

    public ApprovalInbox(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Park a refused action. Returns its id. */
    public long park(String agentId, String tool, String payloadJson, PolicyGate.Risk risk,
                     long amountPaise, String reason, String idempotencyKey) {
        return jdbc.queryForObject(
            "INSERT INTO approvals (agent_id, tool, payload, risk, amount_paise, reason, status, idempotency_key, created_at) " +
            "VALUES (?, ?, ?::jsonb, ?, ?, ?, 'pending', ?, now()) RETURNING id",
            Long.class, agentId, tool, payloadJson == null ? "{}" : payloadJson, risk.name().toLowerCase(), amountPaise, reason,
            // The column is required, and an approval without a key still needs one that is unique.
            idempotencyKey == null ? "approval:" + java.util.UUID.randomUUID() : idempotencyKey);
    }

    public List<Map<String, Object>> pending() {
        return jdbc.queryForList(
            "SELECT id, agent_id, tool, payload, risk, amount_paise, reason, status, created_at " +
            "FROM approvals WHERE status = 'pending' ORDER BY id");
    }

    /** Approve or reject, once. A second decision is a 409, not a second execution. */
    public Map<String, Object> decide(long approvalId, boolean approve, long staffUserId, String note) {
        String status = approve ? "approved" : "rejected";
        int changed = jdbc.update(
            "UPDATE approvals SET status = ?, decided_by = ?, decided_at = now(), note = COALESCE(?, note) " +
            "WHERE id = ? AND status = 'pending'", status, staffUserId, note, approvalId);
        if (changed == 0) throw new ResponseStatusException(HttpStatus.CONFLICT, "That request is not waiting for a decision.");
        return Map.of("id", approvalId, "status", status);
    }
}