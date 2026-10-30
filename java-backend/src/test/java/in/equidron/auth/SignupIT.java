package in.equidron.auth;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.HttpClientErrorException;

/** A new person can create an account, sign in with it, and not create it twice. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SignupIT {

    @Autowired TestRestTemplate http;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach
    void db() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'signup-%@example.com')");
        jdbc.update("DELETE FROM users WHERE email LIKE 'signup-%@example.com'");
    }

    private ResponseEntity<String> post(String body) {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        return new org.springframework.web.client.RestTemplate().postForEntity(
            http.getRootUri() + "/api/shop/signup", new HttpEntity<>(body, h), String.class);
    }

    @Test
    void aNewAccountIsCreatedAndCanSignIn() {
        ResponseEntity<String> out = post("{\"name\":\"Signup Person\",\"email\":\"signup-1@example.com\",\"password\":\"correct horse\"}");
        assertEquals(201, out.getStatusCode().value());
        assertTrue(out.getBody().contains("signup-1@example.com"), out.getBody());

        var signin = new org.springframework.web.client.RestTemplate().postForEntity(
            http.getRootUri() + "/api/shop/login",
            new HttpEntity<>("{\"email\":\"signup-1@example.com\",\"password\":\"correct horse\"}", out.getHeaders()),
            String.class);
        assertEquals(200, signin.getStatusCode().value(), "the password written by signup verifies on log in");
    }

    @Test
    void theSameEmailCannotBeUsedTwice() {
        post("{\"name\":\"Signup Person\",\"email\":\"signup-2@example.com\",\"password\":\"correct horse\"}");
        HttpClientErrorException e = assertThrows(HttpClientErrorException.class,
            () -> post("{\"name\":\"Someone Else\",\"email\":\"signup-2@example.com\",\"password\":\"another one\"}"));
        assertEquals(409, e.getStatusCode().value());
    }

    @Test
    void shortPasswordsAndBadEmailsAreRefused() {
        assertEquals(400, assertThrows(HttpClientErrorException.class,
            () -> post("{\"name\":\"A B\",\"email\":\"signup-3@example.com\",\"password\":\"short\"}")).getStatusCode().value());
        assertEquals(400, assertThrows(HttpClientErrorException.class,
            () -> post("{\"name\":\"A B\",\"email\":\"not-an-email\",\"password\":\"correct horse\"}")).getStatusCode().value());
        assertEquals(400, assertThrows(HttpClientErrorException.class,
            () -> post("{\"name\":\"\",\"email\":\"signup-4@example.com\",\"password\":\"correct horse\"}")).getStatusCode().value());
    }
}