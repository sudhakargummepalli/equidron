package in.equidron.catalog;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/** Search and product detail: read-only, no session needed, same URLs the store already calls. */
@RestController
@RequestMapping("/api/shop")
public class CatalogController {

    private final CatalogRepository catalog;

    public CatalogController(CatalogRepository catalog) {
        this.catalog = catalog;
    }

    @GetMapping("/search")
    public Map<String, Object> search(@RequestParam(name = "q", defaultValue = "") String q,
                                      @RequestParam(name = "limit", defaultValue = "20") int limit) {
        List<Map<String, Object>> results = catalog.search(q, limit);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("results", results);
        out.put("count", results.size());
        return out;
    }

    @GetMapping("/products/{id}")
    public ResponseEntity<Map<String, Object>> product(@PathVariable long id) {
        Map<String, Object> product = catalog.product(id);
        return product == null ? ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "That product is not available."))
            : ResponseEntity.ok(product);
    }
}