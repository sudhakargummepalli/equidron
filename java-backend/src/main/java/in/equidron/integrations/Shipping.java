package in.equidron.integrations;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * Shipping providers. Simulated by default, and it says so; a real carrier is used only when it is
 * configured, and a missing credential fails closed instead of inventing a quote.
 *
 * The quote is deterministic for a pincode so a demo shows the same price twice.
 */
@Service
public class Shipping {

    public record Quote(String carrier, long amountPaise, int etaDays, String mode) {}

    public interface Provider {
        Quote quote(String pincode, int weightGrams);
    }

    private final Provider provider;

    public Shipping(@Value("${SHIPPING_PROVIDER:simulated}") String name,
                    @Value("${SHIPPING_API_KEY:}") String apiKey) {
        this.provider = "http".equalsIgnoreCase(name) ? new HttpProvider(apiKey) : new SimulatedProvider();
    }

    public Quote quote(String pincode, int weightGrams) {
        return provider.quote(pincode, weightGrams);
    }

    static final class SimulatedProvider implements Provider {
        @Override
        public Quote quote(String pincode, int weightGrams) {
            int hash = Math.abs(String.valueOf(pincode).hashCode());
            long base = 4000 + (hash % 6) * 500;          // 40 to 65 rupees
            long perKg = Math.max(0, weightGrams - 500) / 500 * 1500;
            return new Quote("simulated", base + perKg, 2 + (hash % 4), "simulated");
        }
    }

    static final class HttpProvider implements Provider {
        private final String apiKey;

        HttpProvider(String apiKey) {
            this.apiKey = apiKey;
        }

        @Override
        public Quote quote(String pincode, int weightGrams) {
            if (apiKey == null || apiKey.isBlank()) {
                throw new IllegalStateException("SHIPPING_API_KEY is not set; refusing to quote.");
            }
            throw new IllegalStateException("The shipping provider is not implemented for this account yet.");
        }
    }
}