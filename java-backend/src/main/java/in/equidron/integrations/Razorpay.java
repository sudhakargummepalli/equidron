package in.equidron.integrations;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Razorpay: signatures and the mode, without which nothing else may be trusted.
 *
 * Two signatures matter and they are different:
 *   - a payment is "paid" only when HMAC(order_id + "|" + payment_id) matches, using the KEY SECRET;
 *   - a webhook is real only when HMAC(raw body) matches, using the WEBHOOK SECRET.
 * Both are compared in constant time, and both fail closed.
 */
public final class Razorpay {

    /** test keys start rzp_test_; live simulated keys are still test keys. */
    public static String mode(String keyId) {
        return keyId != null && keyId.startsWith("rzp_live_") ? "live" : "test";
    }

    public static boolean verifyPaymentSignature(String orderId, String paymentId, String signature, String keySecret) {
        if (orderId == null || paymentId == null || signature == null || keySecret == null) return false;
        return constantTimeEquals(signature, hmacHex(keySecret, orderId + "|" + paymentId));
    }

    /** Over the RAW body. Parsing the JSON first and re-serialising it breaks this. */
    public static boolean verifyWebhook(String rawBody, String signature, String webhookSecret) {
        if (rawBody == null || signature == null || webhookSecret == null) return false;
        return constantTimeEquals(signature, hmacHex(webhookSecret, rawBody));
    }

    static boolean constantTimeEquals(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    static String hmacHex(String secret, String payload) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("HMAC is required", e);
        }
    }
}