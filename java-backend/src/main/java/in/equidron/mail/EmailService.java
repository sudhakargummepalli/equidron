package in.equidron.mail;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Service;

/**
 * Order confirmation email.
 *
 * Two rules:
 *   1. The message is built by a pure function, so it can be tested without a mail server and reviewed
 *      without reading a template engine.
 *   2. Sending fails closed when SMTP is not configured. A cutover without email must be a visible
 *      decision, not a silent one where customers stop receiving confirmations.
 */
@Service
public class EmailService {

    private final JavaMailSender sender;
    private final String from;
    private final boolean configured;

    public EmailService(JavaMailSender sender,
                        @Value("${spring.mail.host:}") String host,
                        @Value("${MAIL_FROM:}") String from) {
        this.sender = sender;
        this.from = from;
        this.configured = host != null && !host.isBlank() && from != null && !from.isBlank();
    }

    public boolean configured() {
        return configured;
    }

    public record Message(String subject, String body) {}

    /** Pure: the words a customer receives, from the numbers the order already holds. */
    public static Message confirmation(long orderId, String customerName, long totalPaise, String paymentMethod) {
        String total = String.format(java.util.Locale.ROOT, "Rs. %d.%02d", totalPaise / 100, totalPaise % 100);
        String subject = "Order " + orderId + " confirmed";
        String body = "Hello " + (customerName == null || customerName.isBlank() ? "there" : customerName) + ",\n\n"
            + "Thank you for your order. We have received it and the seller has been told.\n\n"
            + "Order number: " + orderId + "\n"
            + "Total: " + total + "\n"
            + "Payment: " + (paymentMethod == null ? "as chosen at checkout" : paymentMethod.toUpperCase()) + "\n\n"
            + "You can see the order and download its invoice from your account.\n\n"
            + "Equidron\n";
        return new Message(subject, body);
    }

    public void send(String to, Message message) {
        if (!configured) throw new IllegalStateException("SMTP is not configured; refusing to claim an email was sent.");
        SimpleMailMessage mail = new SimpleMailMessage();
        mail.setFrom(from);
        mail.setTo(to);
        mail.setSubject(message.subject());
        mail.setText(message.body());
        sender.send(mail);
    }
}