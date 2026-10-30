package in.equidron.integrations;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Base64;

/**
 * Creating a Razorpay order (POST /v1/orders) before the browser opens checkout.
 *
 * Two rules: the amount is in paise and must be at least 100 (one rupee is the provider's minimum),
 * and the simulated provider exists so the checkout flow can be demonstrated without keys - while the
 * HTTP one refuses to run without them rather than inventing an order id.
 */
public final class RazorpayOrders {

    public record CreatedOrder(String id, long amountPaise, String receipt, String mode) {}

    public interface Provider {
        CreatedOrder create(long amountPaise, String receipt);
    }

    public static Provider provider(boolean live, String keyId, String keySecret) {
        return live ? new HttpProvider(keyId, keySecret) : new SimulatedProvider();
    }

    static final class SimulatedProvider implements Provider {
        @Override
        public CreatedOrder create(long amountPaise, String receipt) {
            requireMinimum(amountPaise);
            return new CreatedOrder("order_sim_" + Long.toHexString(System.nanoTime()), amountPaise, receipt, "simulated");
        }
    }

    static final class HttpProvider implements Provider {
        private final String keyId;
        private final String keySecret;

        HttpProvider(String keyId, String keySecret) {
            this.keyId = keyId;
            this.keySecret = keySecret;
        }

        @Override
        public CreatedOrder create(long amountPaise, String receipt) {
            requireMinimum(amountPaise);
            if (keyId == null || keyId.isBlank() || keySecret == null || keySecret.isBlank()) {
                throw new IllegalStateException("Razorpay keys are not set; refusing to create an order.");
            }
            String body = "{\"amount\":" + amountPaise + ",\"currency\":\"INR\",\"receipt\":" + quote(receipt) + ",\"payment_capture\":1}";
            HttpRequest request = HttpRequest.newBuilder(URI.create("https://api.razorpay.com/v1/orders"))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("Authorization", basic(keyId, keySecret))
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
            try {
                HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
                HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() != 200 && response.statusCode() != 201) {
                    throw new IllegalStateException("Razorpay answered " + response.statusCode());
                }
                return new CreatedOrder(field(response.body(), "id"), amountPaise, receipt, "test");
            } catch (java.io.IOException | InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Razorpay could not be reached", e);
            }
        }
    }

    static void requireMinimum(long amountPaise) {
        if (amountPaise < 100) throw new IllegalArgumentException("The minimum payment is 100 paise (one rupee).");
    }

    private static String basic(String id, String secret) {
        return "Basic " + Base64.getEncoder().encodeToString((id + ":" + secret).getBytes());
    }

    private static String quote(String s) {
        return s == null ? "null" : "\"" + s.replace("\"", "\\\"") + "\"";
    }

    private static String field(String json, String name) {
        int i = json.indexOf("\"" + name + "\":\"");
        if (i < 0) return "unknown";
        int start = i + name.length() + 4;
        int end = json.indexOf('"', start);
        return end < 0 ? "unknown" : json.substring(start, end);
    }
}
