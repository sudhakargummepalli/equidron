package in.equidron.mail;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Component;

/**
 * Sends exactly one confirmation, to prove the mail path works end to end.
 *
 * It exists because a fake sender cannot reveal a rejected app password, a wrong port or a provider
 * that wants something else. Run with equal.smtpProof=true and a web type of none; it sends one message
 * to MAIL_FROM and exits, saying plainly what happened.
 */
@Component
@ConditionalOnProperty(name = "equidron.smtpProof", havingValue = "true")
public class SmtpProof implements ApplicationRunner {

    private final EmailService email;
    private final String to;

    public SmtpProof(EmailService email, @org.springframework.beans.factory.annotation.Value("${MAIL_FROM:}") String to) {
        this.email = email;
        this.to = to;
    }

    @Override
    public void run(ApplicationArguments args) {
        System.out.println("SMTP proof: configured=" + email.configured() + " to=" + to);
        EmailService.Message message = EmailService.confirmation(0, "owner", 22900, "cod");
        try {
            email.send(to, message);
            System.out.println("SMTP proof: SENT ok to " + to);
        } catch (RuntimeException e) {
            System.out.println("SMTP proof: FAILED " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }
}