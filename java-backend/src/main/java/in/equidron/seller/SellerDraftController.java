package in.equidron.seller;

import in.equidron.agents.AgentBudget;
import in.equidron.agents.AgentLoop;
import in.equidron.agents.Mask;
import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * The seller's listing agent: rough notes in, a filled-in listing out.
 *
 * What it deliberately does not do:
 *
 *  - It never fetches a photo. A seller could paste any address, and a server that fetches seller-supplied
 *    URLs can be made to read its own network - so the images stay the links the seller already has, and
 *    nothing is downloaded.
 *  - It does not submit. The draft lands in the form, the seller reads it, and the normal submission and
 *    review path decides whether it goes live. An agent that could publish would be a seller with no review.
 *  - It does not invent specifications. Anything the model says that the notes do not support is dropped and
 *    reported as a warning, because a made-up RAM figure is a refund waiting to happen.
 *
 * Every draft is recorded in agent_runs with its cost, and the catalogue agent has a daily budget like the
 * others. Without a key it still helps: a plain, honest draft built from the notes alone.
 */
@RestController
public class SellerDraftController {

    private static final int MAX_NOTES = 2000;

    private final JdbcTemplate jdbc;
    private final SessionService session;
    private final UserRepository users;
    private final AgentLoop.Model model;
    private final AgentBudget budget;

    public SellerDraftController(JdbcTemplate jdbc, SessionService session, UserRepository users,
                                 AgentLoop.Model model, AgentBudget budget) {
        this.jdbc = jdbc;
        this.session = session;
        this.users = users;
        this.model = model;
        this.budget = budget;
    }

    @PostMapping("/api/seller/listing-draft")
    public Map<String, Object> draft(@CookieValue(name = "equidron_session", required = false) String token,
                                     @RequestBody Map<String, Object> body) {
        UserRepository.User user = session.resolve(token, users);
        if (user == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Please sign in.");
        if (!"seller".equals(user.role())) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Seller accounts only.");
        long shopId = jdbc.queryForObject("SELECT id FROM sellers WHERE user_id = ?", Long.class, user.id());

        String notes = String.valueOf(body.getOrDefault("notes", "")).trim();
        if (notes.length() < 10) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Tell us a little about the item.");
        if (notes.length() > MAX_NOTES) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Please keep the notes shorter.");
        List<String> images = (body.get("images") instanceof List<?> list)
            ? list.stream().map(String::valueOf).filter(s -> s.startsWith("http") || s.startsWith("/")).limit(6).toList()
            : List.of();
        String categoryHint = String.valueOf(body.getOrDefault("category", "")).trim();
        String priceHint = String.valueOf(body.getOrDefault("price", "")).trim();

        Map<String, Object> draft = new LinkedHashMap<>();
        List<String> warnings = new ArrayList<>();
        double cost = 0;
        int in = 0;
        int out = 0;

        String answer = null;
        AgentBudget.Budget b = budget.require("catalog_builder");
        if (b.remainingUsd() > 0) {
            try {
                AgentLoop.Completion done = model.complete(system(categoryHint), prompt(notes, priceHint));
                answer = done.text();
                cost = done.costUsd();
                in = done.inputTokens();
                out = done.outputTokens();
            } catch (IllegalStateException e) {
                warnings.add("The model was unavailable, so this draft was built from your notes alone.");
            }
        } else {
            warnings.add("The listing agent has reached its daily budget; this draft was built from your notes alone.");
        }

        if (answer != null) parse(answer, draft, warnings);
        if (draft.get("title") == null || String.valueOf(draft.get("title")).isBlank()) plainDraft(notes, draft);
        if (draft.get("category") == null || String.valueOf(draft.get("category")).isBlank()) {
            draft.put("category", categoryHint.isBlank() ? guessCategory(notes) : categoryHint);
        }
        draft.put("images", images);
        draft.put("warnings", warnings);
        draft.put("notes_kept", notes);

        jdbc.update(
            "INSERT INTO agent_runs (agent_id, trigger, subject, status, summary, input_tokens, output_tokens, " +
            "cost_usd, started_at, finished_at) VALUES ('catalog_builder', 'seller', ?, 'done', ?, ?, ?, ?, now(), now())",
            "seller:" + shopId + " - " + Mask.mask(notes.substring(0, Math.min(80, notes.length()))),
            Mask.mask(String.valueOf(draft.get("title"))), in, out, cost);

        draft.put("cost_usd", cost);
        return draft;
    }

    private String system(String categoryHint) {
        return """
            You turn a seller's rough notes into a product listing for Equidron, an Indian marketplace.
            Reply with JSON only, no prose, in this exact shape:
            {"title":"...","description":"...","category":"...","specs":{"Key":"Value"}}
            Rules:
            - Title: under 70 characters, no ALL CAPS, no "best", no "guaranteed", no emoji. Include brand and the
              one fact that most distinguishes the item.
            - Description: 2 to 4 plain sentences a customer can check against the photos. No marketing words.
            - Specs: only facts the notes state. If the notes do not say it, leave it out. Never guess a number.
            - Category: one of Audio, Books, Fashion, Gadgets, Grocery, Home & Kitchen, Laptops, Phones, Wearables.
            """ + (categoryHint.isBlank() ? "" : "\nThe seller chose the category: " + categoryHint);
    }

    private String prompt(String notes, String priceHint) {
        return "Seller's notes:\n" + notes + "\n\nPrice the seller wants: " + (priceHint.isBlank() ? "not stated" : priceHint);
    }

    /** Reads the JSON the model was asked for, and keeps only what the notes can support. */
    private void parse(String answer, Map<String, Object> draft, List<String> warnings) {
        int start = answer.indexOf('{');
        int end = answer.lastIndexOf('}');
        if (start < 0 || end <= start) {
            warnings.add("The model's answer was not a listing, so a plain draft was built instead.");
            return;
        }
        try {
            var node = new com.fasterxml.jackson.databind.ObjectMapper().readTree(answer.substring(start, end + 1));
            if (node.hasNonNull("title")) draft.put("title", node.get("title").asText().trim());
            if (node.hasNonNull("description")) draft.put("description", node.get("description").asText().trim());
            if (node.hasNonNull("category")) draft.put("category", node.get("category").asText().trim());
            if (node.hasNonNull("specs") && node.get("specs").isObject()) {
                Map<String, String> specs = new LinkedHashMap<>();
                node.get("specs").fields().forEachRemaining(e -> {
                    String value = e.getValue().asText().trim();
                    if (!value.isEmpty() && value.length() < 80) specs.put(e.getKey(), value);
                });
                draft.put("specs", specs);
            }
        } catch (Exception e) {
            warnings.add("The model's answer could not be read, so a plain draft was built instead.");
        }
    }

    /** No model, no problem: the first line becomes the title and the rest the description. */
    private void plainDraft(String notes, Map<String, Object> draft) {
        String[] lines = notes.split("\\r?\\n");
        String title = lines.length == 0 ? notes : lines[0];
        title = title.replaceAll("\\s+", " ").trim();
        if (title.length() > 70) title = title.substring(0, 70).trim();
        draft.put("title", title);
        draft.put("description", notes.replaceAll("\\s+", " ").trim());
    }

    private static String guessCategory(String notes) {
        String n = notes.toLowerCase();
        if (n.matches(".*(phone|laptop|tablet|charger|cable).*")) return "Gadgets";
        if (n.matches(".*(headphone|earbud|speaker|audio).*")) return "Audio";
        if (n.matches(".*(book|novel).*")) return "Books";
        if (n.matches(".*(shirt|kurta|jeans|saree|shoe).*")) return "Fashion";
        if (n.matches(".*(rice|dal|oil|coffee|tea|snack).*")) return "Grocery";
        if (n.matches(".*(watch|band|ring).*")) return "Wearables";
        if (n.matches(".*(kitchen|pan|mixer|home).*")) return "Home & Kitchen";
        return "Gadgets";
    }
}
