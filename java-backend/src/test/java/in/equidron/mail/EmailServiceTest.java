package in.equidron.mail;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

/** The confirmation a customer reads, and the refusal when no mail server is configured. */
class EmailServiceTest {

    @Test
    void theConfirmationNamesTheOrderTheTotalAndThePayment() {
        EmailService.Message m = EmailService.confirmation(67, "Asha", 22900, "cod");
        assertEquals("Order 67 confirmed", m.subject());
        assertTrue(m.body().contains("Hello Asha"), m.body());
        assertTrue(m.body().contains("Order number: 67"), m.body());
        assertTrue(m.body().contains("Total: Rs. 229.00"), m.body());
        assertTrue(m.body().contains("COD"), m.body());
    }

    @Test
    void aMissingNameStillReadsLikeEnglishAndNoMethodIsHonest() {
        EmailService.Message m = EmailService.confirmation(1, null, 100, null);
        assertTrue(m.body().contains("Hello there"), m.body());
        assertTrue(m.body().contains("as chosen at checkout"), m.body());
        assertTrue(m.body().contains("Total: Rs. 1.00"), m.body());
    }

    @Test
    void sendingWithoutSmtpIsRefusedRatherThanPretended() {
        EmailService service = new EmailService(null, "", "");
        assertFalse(service.configured());
        assertThrows(IllegalStateException.class,
            () -> service.send("a@example.com", EmailService.confirmation(1, "A", 100, "cod")));
    }
}