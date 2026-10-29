package in.equidron.auth;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

/**
 * The fixture was produced by the Node implementation (node:crypto scryptSync) with the same salt and
 * cost. If this test passes, a password written by one server can be verified by the other - which is
 * the whole point of a strangler conversion.
 */
class PasswordHasherTest {

    private final PasswordHasher hasher = new PasswordHasher();

    private static final String SALT = "00112233445566778899aabbccddeeff";
    private static final String ALGO = "scrypt:1024:8:1";
    private static final String HASH = "9f0788db49a12ed55eb82a1bca25249df65f522acb89d700bf3bbaeadab7c1f0";

    @Test
    void verifiesAPasswordHashedByTheNodeServer() {
        assertTrue(hasher.matches("equidron-demo", ALGO, SALT, HASH));
    }

    @Test
    void refusesTheWrongPassword() {
        assertFalse(hasher.matches("equidron-demo ", ALGO, SALT, HASH));
        assertFalse(hasher.matches("Equidron-demo", ALGO, SALT, HASH));
        assertFalse(hasher.matches("", ALGO, SALT, HASH));
    }

    @Test
    void refusesMalformedRowsInsteadOfThrowing() {
        assertFalse(hasher.matches("x", null, SALT, HASH));
        assertFalse(hasher.matches("x", "pbkdf2:120000", SALT, HASH));
        assertFalse(hasher.matches("x", ALGO, "nothex", HASH));
        assertFalse(hasher.matches("x", ALGO, SALT, "00"));
    }

    @Test
    void aFreshHashVerifiesAndCarriesTheFullCost() {
        PasswordHasher.Hashed made = hasher.hash("a very long password");
        assertEquals("scrypt:16384:8:5", made.algo());
        assertEquals(16, made.salt().length() / 2);
        assertEquals(64, made.hash().length());
        assertTrue(hasher.matches("a very long password", made.algo(), made.salt(), made.hash()));
        assertFalse(hasher.matches("a very long passworD", made.algo(), made.salt(), made.hash()));
    }

    @Test
    void sessionTokensAreStoredHashedAndStable() {
        assertEquals(64, hasher.tokenHash("abc").length());
        assertEquals(hasher.tokenHash("abc"), hasher.tokenHash("abc"));
        assertNotEquals(hasher.tokenHash("abc"), hasher.tokenHash("abd"));
    }
}