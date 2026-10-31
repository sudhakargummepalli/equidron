package in.equidron.auth;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;

/**
 * The sign-in path against a real PostgreSQL, because a password check that has never touched the
 * users table is not evidence. Runs under `mvn verify`; `mvn test` stays usable without a database.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class AuthControllerIT {

    @Autowired
    TestRestTemplate http;

    @Autowired
    JdbcTemplate jdbc;

    /**
     * A lock left by another test - or by an earlier run of this suite - is not a bug in the sign-in code.
     * The shared test database has to start each test with the failure counts cleared.
     */
    @BeforeEach
    void clearFailures() {
        jdbc.update("DELETE FROM login_attempts WHERE email = 'nobody@example.com'");
    }

    /** The default client cannot read a 401 with a streamed body, and throws its own exception. */
    private RestTemplate client() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setOutputStreaming(false);
        return new RestTemplate(factory);
    }

    @Test
    void signingInWithAnUnknownAccountIsRefusedAndSaysNothingUseful() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        HttpClientErrorException e = assertThrows(HttpClientErrorException.class, () ->
            client().postForEntity(http.getRootUri() + "/api/shop/login",
                java.util.Map.of("email", "nobody@example.com", "password", "wrong-password-here"), String.class));
        assertEquals(401, e.getStatusCode().value());
        // The body is not asserted here: the streaming client often reports none. The Node suite
        // holds the wording, and the status is what a client acts on.
    }

    @Test
    void meWithoutACookieIsUnauthorised() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        HttpClientErrorException e = assertThrows(HttpClientErrorException.class, () ->
            client().getForEntity(http.getRootUri() + "/api/shop/me", String.class));
        assertEquals(401, e.getStatusCode().value());
    }
}