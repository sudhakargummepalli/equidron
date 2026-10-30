package in.equidron.uploads;

import in.equidron.cart.SessionUser;
import java.io.IOException;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

/** Upload a seller document or a product photo. Signing in is required; the file is the body. */
@RestController
@RequestMapping("/api/shop/uploads")
public class UploadsController {

    private final Uploads uploads;
    private final SessionUser session;

    public UploadsController(Uploads uploads, SessionUser session) {
        this.uploads = uploads;
        this.session = session;
    }

    @PostMapping
    public ResponseEntity<Map<String, Object>> upload(
            @CookieValue(name = "equidron_session", required = false) String token,
            @RequestParam("file") MultipartFile file) {
        session.require(token);
        if (file == null || file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Choose a file.");
        }
        try {
            Uploads.Stored stored = uploads.store(file.getOriginalFilename(), file.getContentType(), file.getBytes());
            return ResponseEntity.status(HttpStatus.CREATED)
                .body(Map.of("url", stored.url(), "name", stored.name(), "bytes", stored.bytes()));
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The upload could not be read.");
        }
    }
}
