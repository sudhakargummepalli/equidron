package in.equidron.uploads;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.HttpClientErrorException;

/** The endpoint: a signed-in person can upload, an anonymous one cannot. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class UploadsEndpointIT {

    private static final byte[] PNG = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0};

    @Autowired TestRestTemplate http;
    @Autowired JdbcTemplate jdbc;
    @Autowired SessionService sessions;
    @Autowired UserRepository users;

    private String cookie;

    @BeforeEach
    void aSignedInPerson() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('uploader@example.com', 'Uploader', 'seller', 's', 'h', now()) ON CONFLICT (email) DO NOTHING");
        long id = jdbc.queryForObject("SELECT id FROM users WHERE email = 'uploader@example.com'", Long.class);
        cookie = "equidron_session=" + sessions.create(users.byId(id));
    }

    private ResponseEntity<String> post(String cookie, String filename, byte[] bytes) {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.MULTIPART_FORM_DATA);
        if (cookie != null) h.add(HttpHeaders.COOKIE, cookie);
        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("file", new ByteArrayResource(bytes) {
            @Override public String getFilename() { return filename; }
        });
        return new org.springframework.web.client.RestTemplate().postForEntity(
            http.getRootUri() + "/api/shop/uploads", new HttpEntity<>(body, h), String.class);
    }

    @Test
    void aSignedInPersonCanUploadAndGetsAUrl() {
        ResponseEntity<String> out = post(cookie, "pan.png", PNG);
        assertEquals(201, out.getStatusCode().value(), out.getBody());
        assertTrue(out.getBody().contains("\"/uploads/"), out.getBody());
    }

    @Test
    void anAnonymousUploadIsRefused() {
        assertEquals(401, assertThrows(HttpClientErrorException.class,
            () -> post(null, "pan.png", PNG)).getStatusCode().value());
    }

    @Test
    void aRefusedTypeIsA400NotAServerError() {
        assertEquals(400, assertThrows(HttpClientErrorException.class,
            () -> post(cookie, "shell.exe", PNG)).getStatusCode().value());
    }
}
