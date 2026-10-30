package in.equidron;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

/**
 * The three front doors. The pages are the same static files the Node server serves; Java serves them
 * so their relative /api/... calls land on this backend. A directory has no welcome page in Spring, so
 * each app folder is forwarded to its index.html explicitly.
 */
@Controller
public class HomeController {

    @GetMapping("/")
    public String root() {
        return "redirect:/shop/";
    }

    @GetMapping({"/shop/", "/seller/", "/ops/"})
    public String app() {
        return "forward:/index.html";
    }
}