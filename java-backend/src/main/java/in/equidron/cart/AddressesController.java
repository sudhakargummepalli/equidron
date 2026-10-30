package in.equidron.cart;

import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * Delivery addresses.
 *
 * The form posts one field per input and the page shows the refusal under the right box, so the checks
 * name the field that is wrong rather than saying "invalid". A pincode of six digits and a phone of ten
 * are the two mistakes people actually make.
 */
@RestController
@RequestMapping("/api/shop/addresses")
public class AddressesController {

    private final JdbcTemplate jdbc;
    private final SessionUser session;

    public AddressesController(JdbcTemplate jdbc, SessionUser session) {
        this.jdbc = jdbc;
        this.session = session;
    }

    @GetMapping
    public List<Map<String, Object>> list(@CookieValue(name = "equidron_session", required = false) String token) {
        return jdbc.queryForList(
            "SELECT id, name, line1, city, pincode, phone FROM addresses WHERE user_id = ? ORDER BY id",
            session.require(token));
    }

    @PostMapping
    public Map<String, Object> add(@CookieValue(name = "equidron_session", required = false) String token,
                                   @RequestBody Map<String, Object> body) {
        long userId = session.require(token);
        String name = text(body.get("name"));
        String line1 = text(body.get("line1"));
        String city = text(body.get("city"));
        String pincode = text(body.get("pincode"));
        String phone = text(body.get("phone"));

        if (name.length() < 2) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Tell us who the parcel is for.");
        if (line1.length() < 4) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "A street address is needed.");
        if (city.isEmpty()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Choose a city.");
        if (!pincode.matches("\\d{6}")) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "A PIN code is six digits.");
        if (!phone.replaceAll("[^0-9]", "").matches("\\d{10}")) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "A phone number is ten digits.");

        Long id = jdbc.queryForObject(
            "INSERT INTO addresses (user_id, name, line1, city, pincode, phone) " +
            "VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
            Long.class, userId, name, line1, city, pincode, phone);
        return Map.of("id", id, "ok", true);
    }

    private static String text(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }
}