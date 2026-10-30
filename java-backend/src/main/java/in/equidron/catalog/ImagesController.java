package in.equidron.catalog;

import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

/**
 * Product images, generated rather than stored: /img/p12-1.svg is "the first picture of product 12".
 *
 * The marketplace has no photography, so a placeholder that carries the brand, the category colour and
 * the product's own id is both honest and useful - two products never look the same, and a missing file
 * is impossible because the image is derived from the row.
 */
@RestController
public class ImagesController {

    private static final Map<String, String[]> STYLE = Map.of(
        "Phones", new String[] {"#1d4ed8", "phone"},
        "Laptops", new String[] {"#0f766e", "laptop"},
        "Audio", new String[] {"#7c3aed", "audio"},
        "Wearables", new String[] {"#b45309", "watch"},
        "Books", new String[] {"#9d174d", "book"},
        "Fashion", new String[] {"#be123c", "fashion"},
        "Grocery", new String[] {"#15803d", "grocery"},
        "Home & Kitchen", new String[] {"#a16207", "home"});

    private final JdbcTemplate jdbc;

    public ImagesController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/img/{name}")
    public ResponseEntity<String> image(@PathVariable String name) {
        String base = name.endsWith(".svg") ? name.substring(0, name.length() - 4) : name;
        var parts = java.util.regex.Pattern.compile("^p(\\d+)-(\\d+)$").matcher(base);
        if (!parts.matches()) return ResponseEntity.notFound().build();

        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT title, brand, category FROM products WHERE id = ?", Long.parseLong(parts.group(1)));
        String brand = rows.isEmpty() ? "Equidron" : String.valueOf(rows.get(0).get("brand"));
        String title = rows.isEmpty() ? "Product" : String.valueOf(rows.get(0).get("title"));
        String category = rows.isEmpty() ? "" : String.valueOf(rows.get(0).get("category"));
        String[] style = STYLE.getOrDefault(category, new String[] {"#374151", "product"});
        int index = Integer.parseInt(parts.group(2));

        String svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 400 400\" width=\"400\" height=\"400\">"
            + "<defs><linearGradient id=\"g\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">"
            + "<stop offset=\"0\" stop-color=\"" + style[0] + "\"/><stop offset=\"1\" stop-color=\"#111827\"/>"
            + "</linearGradient></defs>"
            + "<rect width=\"400\" height=\"400\" fill=\"url(#g)\"/>"
            + "<text x=\"200\" y=\"150\" font-size=\"22\" text-anchor=\"middle\" fill=\"#e5e7eb\" font-family=\"sans-serif\">"
            + esc(style[1].toUpperCase()) + "</text>"
            + "<text x=\"200\" y=\"225\" font-size=\"34\" font-weight=\"700\" text-anchor=\"middle\" fill=\"#ffffff\" font-family=\"sans-serif\">"
            + esc(brand) + "</text>"
            + "<text x=\"200\" y=\"265\" font-size=\"16\" text-anchor=\"middle\" fill=\"#cbd5e1\" font-family=\"sans-serif\">"
            + esc(shorten(title)) + "</text>"
            + "<text x=\"200\" y=\"330\" font-size=\"14\" text-anchor=\"middle\" fill=\"#94a3b8\" font-family=\"sans-serif\">"
            + "Image " + index + " · Equidron</text></svg>";

        return ResponseEntity.ok().contentType(MediaType.valueOf("image/svg+xml")).body(svg);
    }

    private static String shorten(String text) {
        return text.length() <= 38 ? text : text.substring(0, 35) + "…";
    }

    private static String esc(String text) {
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }
}