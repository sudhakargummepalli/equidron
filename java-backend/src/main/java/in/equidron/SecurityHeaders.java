package in.equidron;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Security headers for every response.
 *
 * These are the same headers the Node server sent from netlify.toml - a page that was safe behind Netlify
 * must not become unsafe because it is now served by a JVM. The content security policy allows the two
 * Razorpay origins because the checkout script loads from there, and forbids framing because a marketplace
 * inside somebody else's frame is how card forms get stolen.
 */
public final class SecurityHeaders {

    public static final Map<String, String> ALL;

    static {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Security-Policy",
            "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com https://checkout.razorpay.com; "
            + "style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; "
            + "connect-src 'self' https://api.razorpay.com https://checkout.razorpay.com; "
            + "frame-src https://api.razorpay.com https://checkout.razorpay.com; font-src 'self'; "
            + "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("X-Frame-Options", "DENY");
        headers.put("Referrer-Policy", "strict-origin-when-cross-origin");
        headers.put("Permissions-Policy", "camera=(), geolocation=(), payment=(), microphone=(self)");
        ALL = Map.copyOf(headers);
    }

    private SecurityHeaders() {
    }
}