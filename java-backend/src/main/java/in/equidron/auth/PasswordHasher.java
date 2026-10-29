package in.equidron.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.crypto.generators.SCrypt;
import org.springframework.stereotype.Component;

/**
 * Passwords, in the exact format the Node server writes: {@code pw_algo} "scrypt:N:r:p", a hex salt
 * and a hex hash. Accounts must keep working when a slice moves to Java, so the format is not a
 * choice - it is a contract with the rows already in the database.
 *
 * The comparison is constant time, because a fast "no" leaks how much of the hash was right.
 */
@Component
public class PasswordHasher {

    private static final int KEY_BYTES = 32;

    /** Verify a password against a stored algorithm string, salt and hash. */
    public boolean matches(String password, String algo, String saltHex, String hashHex) {
        if (password == null || algo == null || saltHex == null || hashHex == null) return false;
        String[] parts = algo.split(":");
        if (parts.length != 4 || !"scrypt".equals(parts[0])) return false; // PBKDF2 rows are Phase 1 legacy
        int n = Integer.parseInt(parts[1]);
        int r = Integer.parseInt(parts[2]);
        int p = Integer.parseInt(parts[3]);
        byte[] salt;
        byte[] expected;
        try {
            salt = HexFormat.of().parseHex(saltHex);
            expected = HexFormat.of().parseHex(hashHex);
        } catch (RuntimeException e) {
            return false; // a corrupted row is a failed login, not a 500
        }
        byte[] actual;
        try {
            actual = SCrypt.generate(password.getBytes(StandardCharsets.UTF_8), salt, n, r, p, KEY_BYTES);
        } catch (RuntimeException e) {
            return false;
        }
        return MessageDigest.isEqual(expected, actual);
    }

    /** The same shape the Node server produces, for new accounts and password changes. */
    public Hashed hash(String password) {
        byte[] salt = new byte[16];
        new java.security.SecureRandom().nextBytes(salt);
        int n = 16384, r = 8, p = 5;
        byte[] key = SCrypt.generate(password.getBytes(StandardCharsets.UTF_8), salt, n, r, p, KEY_BYTES);
        HexFormat hex = HexFormat.of();
        return new Hashed("scrypt:" + n + ":" + r + ":" + p, hex.formatHex(salt), hex.formatHex(key));
    }

    /** Session tokens are stored hashed, so a database dump cannot be replayed as a login. */
    public String tokenHash(String token) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required", e);
        }
    }

    public record Hashed(String algo, String salt, String hash) {}
}