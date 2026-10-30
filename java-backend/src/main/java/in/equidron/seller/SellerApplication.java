package in.equidron.seller;

import in.equidron.integrations.Kyc;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Becoming a seller: a draft that survives a reload, a submission that means something, and a review
 * that runs KYC before the shop exists.
 *
 * A draft is saved even when incomplete, because a form that loses a bank account number on refresh is
 * a form nobody finishes. Submission is where the checks are: it refuses an incomplete draft instead of
 * creating a seller who cannot be paid.
 */
@Service
public class SellerApplication {

    private final JdbcTemplate jdbc;
    private final Kyc kyc;

    public SellerApplication(JdbcTemplate jdbc, Kyc kyc) {
        this.jdbc = jdbc;
        this.kyc = kyc;
    }

    private static final List<String> FIELDS = List.of(
        "business_name", "business_type", "pan", "gstin", "bank_account_name", "bank_account_no",
        "bank_ifsc", "pickup_line1", "pickup_city", "pickup_pincode", "pickup_phone");

    public Map<String, Object> draft(long userId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT * FROM seller_applications WHERE user_id = ?", userId);
        return rows.isEmpty() ? Map.of("status", "none") : rows.get(0);
    }

    /** Save or update the caller's draft. Unknown keys are ignored rather than stored. */
    @Transactional
    public Map<String, Object> saveDraft(long userId, Map<String, Object> body) {
        List<Map<String, Object>> existing = jdbc.queryForList(
            "SELECT id, status FROM seller_applications WHERE user_id = ?", userId);
        if (!existing.isEmpty() && "approved".equals(existing.get(0).get("status"))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "This application is already approved.");
        }
        if (existing.isEmpty()) {
            jdbc.update("INSERT INTO seller_applications (user_id, status, created_at, updated_at) VALUES (?, 'draft', now(), now())", userId);
        }
        for (String field : FIELDS) {
            if (body.containsKey(field)) {
                jdbc.update("UPDATE seller_applications SET " + field + " = ?, updated_at = now() WHERE user_id = ?",
                    body.get(field) == null ? null : String.valueOf(body.get(field)).trim(), userId);
            }
        }
        return draft(userId);
    }

    /** Submit, run KYC, and become a seller only if the applicant can actually be paid. */
    @Transactional
    public Map<String, Object> submit(long userId) {
        List<Map<String, Object>> rows = jdbc.queryForList("SELECT * FROM seller_applications WHERE user_id = ?", userId);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Nothing has been saved yet.");
        Map<String, Object> app = rows.get(0);
        for (String field : FIELDS) {
            Object value = app.get(field);
            if (value == null || String.valueOf(value).isBlank()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The application is missing " + field.replace('_', ' ') + ".");
            }
        }
        String pan = String.valueOf(app.get("pan"));
        if (!pan.matches("[A-Z]{5}[0-9]{4}[A-Z]")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The PAN does not look right.");
        }
        String ifsc = String.valueOf(app.get("bank_ifsc"));
        if (!ifsc.matches("[A-Z]{4}0[A-Z0-9]{6}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The IFSC does not look right.");
        }

        Kyc.Result result = kyc.verify(pan, String.valueOf(app.get("bank_account_name")));
        jdbc.update("UPDATE seller_applications SET status = 'submitted', submitted_at = now(), kyc_status = ?, " +
                    "kyc_ref = ?, kyc_at = now(), updated_at = now() WHERE user_id = ?",
            result.status().name().toLowerCase(), result.ref(), userId);

        Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("status", "submitted");
        out.put("kyc_status", result.status().name().toLowerCase());
        out.put("kyc_mode", result.mode());
        return out;
    }

    /** Ops decides. Approval is what creates the shop and changes the person's role. */
    @Transactional
    public Map<String, Object> review(long userId, boolean approve) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT id, business_name, pickup_city, kyc_status FROM seller_applications WHERE user_id = ?", userId);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No application for that seller.");
        if (!"submitted".equals(String.valueOf(draft(userId).get("status")))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "That application is not waiting for review.");
        }
        String status = approve ? "approved" : "rejected";
        jdbc.update("UPDATE seller_applications SET status = ?, updated_at = now() WHERE user_id = ?", status, userId);
        if (approve) {
            String name = String.valueOf(rows.get(0).get("business_name"));
            jdbc.update("INSERT INTO sellers (user_id, name, rating, rating_count, city, is_sample) " +
                        "VALUES (?, ?, 4.0, 0, ?, false) ON CONFLICT (user_id) DO NOTHING",
                userId, name, String.valueOf(rows.get(0).get("pickup_city")));
            jdbc.update("UPDATE users SET role = 'seller' WHERE id = ?", userId);
        } else {
            jdbc.update("UPDATE users SET role = 'customer' WHERE id = ? AND role = 'seller'", userId);
        }
        return Map.of("status", status);
    }
}