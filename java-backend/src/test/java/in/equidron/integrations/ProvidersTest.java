package in.equidron.integrations;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

/** The simulated providers cover every branch, and the HTTP ones fail closed without a key. */
class ProvidersTest {

    @Test
    void aShippingQuoteIsDeterministicAndSaysItIsSimulated() {
        Shipping shipping = new Shipping("simulated", "");
        var quote = shipping.quote("560038", 500);
        assertEquals("simulated", quote.mode());
        assertTrue(quote.amountPaise() >= 4000 && quote.amountPaise() <= 7000, "a plausible Indian quote: " + quote.amountPaise());
        assertTrue(quote.etaDays() >= 2 && quote.etaDays() <= 5);
        assertEquals(quote.amountPaise(), shipping.quote("560038", 500).amountPaise(), "the same pincode quotes the same price");
        assertTrue(shipping.quote("560038", 1500).amountPaise() > quote.amountPaise(), "heavier costs more");
    }

    @Test
    void aShippingProviderWithoutAKeyRefusesToQuote() {
        Shipping shipping = new Shipping("http", "");
        assertThrows(IllegalStateException.class, () -> shipping.quote("560038", 500));
    }

    @Test
    void theSimulatedKycCoversVerifiedMismatchAndRejected() {
        Kyc kyc = new Kyc("simulated", "");
        assertEquals(Kyc.Status.VERIFIED, kyc.verify("ABCDE1234A", "Asha").status());
        assertEquals(Kyc.Status.NAME_MISMATCH, kyc.verify("ABCDE1234B", "Asha").status());
        assertEquals(Kyc.Status.REJECTED, kyc.verify("ABCDE1234C", "Asha").status());
        assertEquals(Kyc.Status.REJECTED, kyc.verify("not-a-pan", "Asha").status());
        assertEquals(Kyc.Status.REJECTED, kyc.verify(null, "Asha").status());
        assertEquals("simulated", kyc.verify("ABCDE1234A", "Asha").mode());
    }

    @Test
    void aKycVendorWithoutAKeyRefusesToVerify() {
        Kyc kyc = new Kyc("http", "");
        assertThrows(IllegalStateException.class, () -> kyc.verify("ABCDE1234A", "Asha"));
    }
}