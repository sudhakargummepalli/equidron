package in.equidron.integrations;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

/** Signatures are pure HMAC: the vectors below are computed the same way an attacker would. */
class RazorpayTest {

    private static final String KEY_SECRET = "test_key_secret";
    private static final String WEBHOOK_SECRET = "whsec_test";

    @Test
    void aPaymentSignatureIsVerifiedOverOrderPipePayment() {
        String signature = Razorpay.hmacHex(KEY_SECRET, "order_ABC|pay_XYZ");
        assertTrue(Razorpay.verifyPaymentSignature("order_ABC", "pay_XYZ", signature, KEY_SECRET));
        assertFalse(Razorpay.verifyPaymentSignature("order_ABC", "pay_OTHER", signature, KEY_SECRET));
        assertFalse(Razorpay.verifyPaymentSignature("order_ABC", "pay_XYZ", signature, "wrong_secret"));
        assertFalse(Razorpay.verifyPaymentSignature("order_ABC", "pay_XYZ", signature, null));
    }

    @Test
    void aWebhookIsVerifiedOverTheRawBodyAndNotARoundTrip() {
        String body = "{\"event\":\"payment.captured\",\"payload\":{\"payment\":{\"entity\":{\"id\":\"pay_1\"}}}}";
        String signature = Razorpay.hmacHex(WEBHOOK_SECRET, body);
        assertTrue(Razorpay.verifyWebhook(body, signature, WEBHOOK_SECRET));
        // Re-serialised JSON has different bytes even when it means the same thing.
        assertFalse(Razorpay.verifyWebhook(body.replace("{\"event\"", "{ \"event\""), signature, WEBHOOK_SECRET));
        assertFalse(Razorpay.verifyWebhook(body, signature, "another_secret"));
        assertFalse(Razorpay.verifyWebhook(body, null, WEBHOOK_SECRET));
    }

    @Test
    void anInvalidHexSignatureIsAFailedVerificationNotACrash() {
        assertFalse(Razorpay.verifyPaymentSignature("order_ABC", "pay_XYZ", "zz", KEY_SECRET));
        assertFalse(Razorpay.verifyWebhook("{}", "", WEBHOOK_SECRET));
    }

    @Test
    void theModeComesFromTheKeyPrefix() {
        assertEquals("test", Razorpay.mode("rzp_test_TteAr9vxegiCqz"));
        assertEquals("live", Razorpay.mode("rzp_live_abc"));
        assertEquals("test", Razorpay.mode(null));
    }
}