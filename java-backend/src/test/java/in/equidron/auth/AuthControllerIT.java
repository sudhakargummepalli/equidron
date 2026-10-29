package in.equidron.auth;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.*;

/**
 * The sign-in path against a real PostgreSQL, because a password check that has never touched the
 * users table is not evidence. Skipped when DATABASE_URL is unset: a developer without a database
 * should get "skipped", not a red build.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class AuthControllerIT {

    @Autowired
    TestRestTemplate http;

    @Test
    void signingInWithTheWrongPasswordIsRefusedAndSaysNothingUseful() {
    assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        ResponseEntity<String> out = http.postForEntity("/api/shop/login",
            java.util.Map.of("email", "nobody@example.com", "password", "wrong-password-here"), String.class);
        assertEquals(HttpStatus.UNAUTHORIZED, out.getStatusCode());
        assertTrue(out.getBody().contains("do not match"), out.getBody());
    }

    @Test
    void meWithoutACookieIsUnauthorised() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        ResponseEntity<String> out = http.getForEntity("/api/shop/me", String.class);
        assertEquals(HttpStatus.UNAUTHORIZED, out.getStatusCode());
    }
}
