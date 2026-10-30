package in.equidron;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;

/**
 * Every refusal reaches the pages as a sentence, not a status word.
 *
 * A thrown ResponseStatusException is otherwise answered by Spring's default error body, which puts
 * "Conflict" or "Not Found" in the error field, so a customer reads the HTTP reason phrase where a
 * sentence was written. The pages already show body.error; this puts the sentence back.
 */
@RestControllerAdvice
public class ApiErrors {

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> refusal(ResponseStatusException e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", e.getReason() == null ? "That did not work." : e.getReason());
        body.put("status", e.getStatusCode().value());
        return ResponseEntity.status(e.getStatusCode()).body(body);
    }
}