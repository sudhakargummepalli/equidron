package in.equidron.integrations;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * KYC for seller applications. Simulated by default.
 *
 * The simulated rule is a readable one, not a fake pass: a PAN ending A is verified, one ending B is a
 * name mismatch, anything else is rejected. That way the demo exercises every branch a real vendor
 * would produce.
 */
@Service
public class Kyc {

    public enum Status { VERIFIED, NAME_MISMATCH, REJECTED }

    public record Result(Status status, String ref, String mode) {}

    public interface Provider {
        Result verify(String pan, String name);
    }

    private final Provider provider;

    public Kyc(@Value("${KYC_PROVIDER:simulated}") String name, @Value("${KYC_API_KEY:}") String apiKey) {
        this.provider = "http".equalsIgnoreCase(name) ? new HttpProvider(apiKey) : new SimulatedProvider();
    }

    public Result verify(String pan, String name) {
        return provider.verify(pan, name);
    }

    static final class SimulatedProvider implements Provider {
        @Override
        public Result verify(String pan, String name) {
            String p = pan == null ? "" : pan.trim().toUpperCase();
            if (!p.matches("[A-Z]{5}[0-9]{4}[A-Z]")) {
                return new Result(Status.REJECTED, "sim-invalid", "simulated");
            }
            Status status = p.endsWith("A") ? Status.VERIFIED
                : p.endsWith("B") ? Status.NAME_MISMATCH : Status.REJECTED;
            return new Result(status, "sim-" + p.substring(p.length() - 4), "simulated");
        }
    }

    static final class HttpProvider implements Provider {
        private final String apiKey;

        HttpProvider(String apiKey) {
            this.apiKey = apiKey;
        }

        @Override
        public Result verify(String pan, String name) {
            if (apiKey == null || apiKey.isBlank()) {
                throw new IllegalStateException("KYC_API_KEY is not set; refusing to verify.");
            }
            throw new IllegalStateException("The KYC vendor is not implemented for this account yet.");
        }
    }
}