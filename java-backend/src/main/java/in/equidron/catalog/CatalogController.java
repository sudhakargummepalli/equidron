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
                                      @RequestParam(name = "category", defaultValue = "") String category,
                                      @RequestParam(name = "limit", defaultValue = "20") int limit,
                                      @RequestParam(name = "page", required = false) Integer page) {
        int perPage = Math.min(50, Math.max(1, limit));
        int currentPage = page == null ? 1 : Math.max(1, page);
        List<Map<String, Object>> results = catalog.search(q, category, perPage, (currentPage - 1) * perPage);
        int total = catalog.countSearch(q, category);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("results", results);
        out.put("count", results.size());
        out.put("total", total);
        out.put("page", currentPage);
        out.put("pages", Math.max(1, (int) Math.ceil(total / (double) perPage)));
        return out;
    }

    @GetMapping("/meta")
    public Map<String, Object> meta() {
        return Map.of("cities", catalog.cities(), "categories", catalog.categories(), "sample", false);
    }

    @GetMapping("/products/{id}")
    public ResponseEntity<Map<String, Object>> product(@PathVariable long id,
                                                       @RequestParam(name = "city", required = false) String city) {
        Map<String, Object> product = catalog.product(id, city);
        return product == null ? ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "That product is not available."))
            : ResponseEntity.ok(product);
    }
}