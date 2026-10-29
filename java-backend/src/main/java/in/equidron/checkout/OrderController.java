package in.equidron.checkout;

import in.equidron.cart.SessionUser;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/** The order history the store reads after checkout. */
@RestController
@RequestMapping("/api/shop/orders")
public class OrderController {

    private final OrderRepository orders;
    private final SessionUser session;

    public OrderController(OrderRepository orders, SessionUser session) {
        this.orders = orders;
        this.session = session;
    }

    @GetMapping
    public List<Map<String, Object>> list(@CookieValue(name = "equidron_session", required = false) String token) {
        return orders.list(session.require(token));
    }

    @GetMapping("/{id}")
    public ResponseEntity<Map<String, Object>> one(@CookieValue(name = "equidron_session", required = false) String token,
                                                   @PathVariable long id) {
        Map<String, Object> order = orders.one(session.require(token), id);
        return order == null
            ? ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "Order not found."))
            : ResponseEntity.ok(order);
    }
}