package in.equidron.mail;

import in.equidron.auth.RegisterController;
import org.springframework.stereotype.Component;

/** Sends the confirmation code through the same mail path as everything else. */
@Component
public class EmailCodes implements RegisterController.MailPort {

    private final EmailService email;

    public EmailCodes(EmailService email) {
        this.email = email;
    }

    @Override
    public void sendCode(String to, String code) {
        email.send(to, new EmailService.Message("Confirm your Equidron account",
            "Your Equidron code is " + code + ". It expires in 30 minutes. " +
            "If you didn't create an account, ignore this email."));
    }
}