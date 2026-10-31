package in.equidron;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** The headers are a promise to the browser, so they are asserted rather than assumed. */
class SecurityHeadersTest {

    @Test
    void everyHeaderTheMarketplaceNeedsIsPresent() {
        String csp = SecurityHeaders.ALL.get("Content-Security-Policy");
        assertTrue(csp.contains("frame-ancestors 'none'"), "the pages must not be framable");
        assertTrue(csp.contains("object-src 'none'"), "no plugins");
        assertTrue(csp.contains("https://checkout.razorpay.com"), "the checkout script loads from Razorpay");
        assertTrue(SecurityHeaders.ALL.get("X-Frame-Options").equals("DENY"), "framing refused twice, for old browsers");
        assertTrue(SecurityHeaders.ALL.get("X-Content-Type-Options").equals("nosniff"), "no type sniffing");
        assertTrue(SecurityHeaders.ALL.containsKey("Referrer-Policy"), "referrers limited");
        assertTrue(SecurityHeaders.ALL.containsKey("Permissions-Policy"), "sensors refused");
    }
}