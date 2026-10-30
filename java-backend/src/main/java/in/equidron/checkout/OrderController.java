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

    @PostMapping("/{id}/returns")
    public ResponseEntity<Map<String, Object>> requestReturn(
            @CookieValue(name = "equidron_session", required = false) String token,
            @PathVariable long id, @RequestBody Map<String, Object> body) {
        long userId = session.require(token);
        long itemId = ((Number) body.get("order_item_id")).longValue();
        int qty = body.get("qty") == null ? 1 : ((Number) body.get("qty")).intValue();
        Map<String, Object> order = orders.requestReturn(userId, id, itemId, qty, (String) body.get("reason"));
        return order == null
            ? ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "Order not found."))
            : ResponseEntity.ok(order);
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