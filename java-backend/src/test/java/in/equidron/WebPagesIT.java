package in.equidron;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.ResponseEntity;

/** The pages load from Java with and without the trailing slash. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class WebPagesIT {

    @Autowired TestRestTemplate http;

    @Test
    void theStorePageLoadsWithAndWithoutTheTrailingSlash() {
        for (String path : new String[] {"/shop/", "/shop/index.html"}) {
            ResponseEntity<String> out = http.getForEntity(http.getRootUri() + path, String.class);
            assertEquals(200, out.getStatusCode().value(), path);
            assertTrue(out.getBody() != null && out.getBody().contains("<html"), "the real page at " + path);
        }
    }

    @Test
    void theSellerAndOpsPagesLoadToo() {
        for (String path : new String[] {"/seller/", "/ops/"}) {
            assertEquals(200, http.getForEntity(http.getRootUri() + path, String.class).getStatusCode().value(), path);
        }
    }
}