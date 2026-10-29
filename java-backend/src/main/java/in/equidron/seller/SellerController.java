package in.equidron.seller;

import in.equidron.cart.SessionUser;
import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

/** Seller Central: the listings a shop owns, and the two things it changes most often. */
@RestController
@RequestMapping("/api/seller")
public class SellerController {

    private final SellerRepository sellers;
    private final SessionUser session;
    private final SessionService sessions;
    private final UserRepository users;

    public SellerController(SellerRepository sellers, SessionUser session, SessionService sessions, UserRepository users) {
        this.sellers = sellers;
        this.session = session;
        this.sessions = sessions;
        this.users = users;
    }

    @GetMapping("/listings")
    public List<Map<String, Object>> listings(@CookieValue(name = "equidron_session", required = false) String token) {
        return sellers.listings(sellers.shopOf(session.require(token)));
    }

    @GetMapping("/dashboard")
    public Map<String, Object> dashboard(@CookieValue(name = "equidron_session", required = false) String token) {
        return sellers.dashboard(sellers.shopOf(session.require(token)));
    }

    @PutMapping("/listings/{offerId}")
    public Map<String, Object> update(@CookieValue(name = "equidron_session", required = false) String token,
                                      @PathVariable long offerId, @RequestBody Map<String, Object> body) {
        long shopId = sellers.shopOf(session.require(token));
        Long price = body.get("price_paise") == null ? null : ((Number) body.get("price_paise")).longValue();
        Integer qty = body.get("qty") == null ? null : ((Number) body.get("qty")).intValue();
        return sellers.update(shopId, offerId, price, qty);
    }
}