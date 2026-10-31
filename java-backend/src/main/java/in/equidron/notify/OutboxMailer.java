package in.equidron.notify;

import in.equidron.agents.Mask;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Component;

/**
 * The job that drains the outbox.
 *
 * It is a job rather than a send-on-request for the reason in OutboxService: a mail server having a bad
 * morning must not become a shop that cannot take an order.
 *
 * Without SMTP configured it does not pretend. It records a clear reason and lets the retry policy decide when
 * to give up, so a developer can see exactly what is waiting and why it is waiting - which is far more useful
 * than a silent success, and much safer than printing the email to a log and calling it sent.
 */
@Component
public class OutboxMailer {

    private static final Logger log = LoggerFactory.getLogger(OutboxMailer.class);

    private final OutboxService outbox;
    private final ObjectProvider<JavaMailSender> mailSender;
    private final String from;
    private final boolean configured;

    public OutboxMailer(OutboxService outbox, ObjectProvider<JavaMailSender> mailSender,
                        @Value("${SMTP_HOST:}") String host,
                        @Value("${MAIL_FROM:}") String from) {
        this.outbox = outbox;
        this.mailSender = mailSender;
        this.from = from;
        this.configured = host != null && !host.isBlank();
    }

    /** Send what is waiting; returns how many went out. */
    public int drain(int limit) {
        if (!configured) {
            // Nothing is sent, and nothing is marked sent: the queue stays honest about its state.
            return 0;
        }
        int sent = 0;
        List<Map<String, Object>> rows = outbox.claim(limit);
        for (Map<String, Object> row : rows) {
            long id = ((Number) row.get("id")).longValue();
            try {
                SimpleMailMessage message = new SimpleMailMessage();
                message.setFrom(from.isBlank() ? "no-reply@equidron.local" : from);
                message.setTo(String.valueOf(row.get("to_address")));
                message.setSubject(String.valueOf(row.get("subject")));
                message.setText(String.valueOf(row.get("body")));
                JavaMailSender sender = mailSender.getIfAvailable();
                if (sender == null) throw new IllegalStateException("no mail sender is configured");
                sender.send(message);
                outbox.sent(id);
                sent++;
            } catch (RuntimeException e) {
                String reason = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                outbox.failed(id, Mask.mask(reason));
                log.warn("outbox {} could not be sent: {}", id, Mask.mask(reason));
            }
        }
        return sent;
    }

    /** What the Ops system panel shows: is mail actually wired, and what is waiting. */
    public Map<String, Object> status() {
        Map<String, Object> stats = outbox.stats();
        return Map.of("smtp_configured", configured, "outbox", stats);
    }
}
