package in.equidron;

import in.equidron.agents.AgentService;
import in.equidron.agents.ApprovalInbox;
import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import in.equidron.cart.SessionUser;
import in.equidron.integrations.PaymentGateway;
import in.equidron.invoices.InvoicePdf;
import in.equidron.invoices.Invoices;
import in.equidron.rights.DataRights;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * The endpoints the existing pages call that had a service but no door.
 *
 * Nothing new is decided here: every route delegates to a service that is already tested, and every
 * route checks the session before touching anything.
 */
@RestController
public class ApiSurfaceController {

    private final SessionUser session;
    private final SessionService sessions;
    private final UserRepository users;
    private final Invoices invoices;
    private final DataRights rights;
    private final AgentService agents;
    private final ApprovalInbox approvals;
    private final PaymentGateway payments;

    public ApiSurfaceController(SessionUser session, SessionService sessions, UserRepository users,
                                Invoices invoices, DataRights rights, AgentService agents,
                                ApprovalInbox approvals, PaymentGateway payments) {
        this.session = session;
        this.sessions = sessions;
        this.users = users;
        this.invoices = invoices;
        this.rights = rights;
        this.agents = agents;
        this.approvals = approvals;
        this.payments = payments;
    }

    private UserRepository.User staff(String token) {
        UserRepository.User user = sessions.resolve(token, users);
        if (user == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Please sign in.");
        if (!"ops".equals(user.role()) && !"admin".equals(user.role())) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Staff only.");
        return user;
    }

    /** The invoice a customer keeps: issued once, then the same number every time. */
    @GetMapping("/api/shop/orders/{id}/invoice")
    public ResponseEntity<byte[]> invoice(@CookieValue(name = "equidron_session", required = false) String token,
                                          @PathVariable long id) {
        long userId = session.require(token);
        Map<String, Object> issued = invoices.issue(id);
        Map<String, Object> row = invoices.view(id, userId);
        if (row == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Invoice not found.");
        byte[] pdf = InvoicePdf.render("" + issued.get("number"), "" + row.get("issued_on"),
            List.of(new InvoicePdf.Line("Order", "" + id),
                new InvoicePdf.Line("Taxable", "Rs. " + row.get("taxable_paise_list")),
                new InvoicePdf.Line("CGST 9%", "Rs. " + row.get("cgst_paise_list")),
                new InvoicePdf.Line("SGST 9%", "Rs. " + row.get("sgst_paise_list")),
                new InvoicePdf.Line("IGST", "Rs. " + row.get("igst_paise_list")),
                new InvoicePdf.Line("Total", "Rs. " + row.get("total_paise_list"))));
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=" + issued.get("number") + ".pdf")
            .contentType(MediaType.APPLICATION_PDF)
            .body(pdf);
    }

    @GetMapping("/api/shop/my-data")
    public Map<String, Object> myData(@CookieValue(name = "equidron_session", required = false) String token) {
        return rights.exportFor(session.require(token));
    }

    @PostMapping("/api/shop/delete-account")
    public Map<String, Object> deleteAccount(@CookieValue(name = "equidron_session", required = false) String token,
                                             @RequestBody Map<String, Object> body) {
        long userId = session.require(token);
        return rights.deleteAccount(userId, String.valueOf(body.getOrDefault("confirmation", "")));
    }

    @PostMapping("/api/shop/orders/{id}/pay/start")
    public Map<String, Object> startPayment(@CookieValue(name = "equidron_session", required = false) String token,
                                            @PathVariable long id) {
        return payments.start(id, session.require(token));
    }

    /** Ops may ask an agent to work on something; the service enforces budget and policy. */
    @PostMapping("/api/ops/agents/{agentId}/run")
    public Map<String, Object> runAgent(@CookieValue(name = "equidron_session", required = false) String token,
                                        @PathVariable String agentId, @RequestBody Map<String, Object> body) {
        staff(token);
        String task = String.valueOf(body.getOrDefault("task", "")).trim();
        if (task.length() < 3) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Say what the agent should do.");
        int level = body.get("level") == null ? 1 : ((Number) body.get("level")).intValue();
        return agents.run(agentId, level, String.valueOf(body.getOrDefault("trigger", "manual")), task);
    }

    @GetMapping("/api/ops/approvals")
    public List<Map<String, Object>> pendingApprovals(
            @CookieValue(name = "equidron_session", required = false) String token) {
        staff(token);
        return approvals.pending();
    }

    @PostMapping("/api/ops/approvals/{id}/{decision}")
    public Map<String, Object> decideApproval(@CookieValue(name = "equidron_session", required = false) String token,
                                              @PathVariable long id, @PathVariable String decision,
                                              @RequestBody(required = false) Map<String, Object> body) {
        UserRepository.User user = staff(token);
        if (!List.of("approve", "reject").contains(decision)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unknown decision.");
        }
        String note = body == null ? null : (String) body.get("note");
        return approvals.decide(id, "approve".equals(decision), user.id(), note);
    }
}