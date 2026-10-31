package in.equidron.cart;

import java.util.Map;
import org.springframework.web.bind.annotation.*;

/**
 * The cart endpoints the store already calls. Reading needs the session; every write goes through
 * the same three verbs, so a page does not have to guess which one a button uses.
 */
@RestController
@RequestMapping("/api/shop/cart")
public class CartController {

    private final CartRepository cart;
    private final SessionUser session;

    public CartController(CartRepository cart, SessionUser session) {
        this.cart = cart;
        this.session = session;
    }

    @GetMapping
    public Map<String, Object> view(@CookieValue(name = "equidron_session", required = false) String token) {
        return cart.view(session.require(token));
    }

    @PostMapping
    public Map<String, Object> add(@CookieValue(name = "equidron_session", required = false) String token,
                                   @RequestBody Map<String, Object> body) {
        long userId = session.require(token);
        long offerId = ((Number) body.get("offer_id")).longValue();
        int qty = body.get("qty") == null ? 1 : ((Number) body.get("qty")).intValue();
        cart.add(userId, offerId, Math.max(1, qty));
        return cart.view(userId);
    }

    @PutMapping("/{offerId}")
    public Map<String, Object> set(@CookieValue(name = "equidron_session", required = false) String token,
                                   @PathVariable long offerId, @RequestBody Map<String, Object> body) {
        long userId = session.require(token);
        Object qty = body.get("qty");
        if (qty == null) throw new org.springframework.web.server.ResponseStatusException(
            org.springframework.http.HttpStatus.BAD_REQUEST, "Say how many you want.");
        cart.setQty(userId, offerId, ((Number) qty).intValue());
        return cart.view(userId);
    }

    @DeleteMapping("/{offerId}")
    public Map<String, Object> remove(@CookieValue(name = "equidron_session", required = false) String token,
                                      @PathVariable long offerId) {
        long userId = session.require(token);
        cart.remove(userId, offerId);
        return cart.view(userId);
    }
}