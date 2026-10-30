package in.equidron.agents;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/** The DeepSeek chat call behind the loop's Model interface. Costs are estimated from token counts. */
final class DeepSeekModel implements AgentLoop.Model {

    private static final double COST_PER_1K_INPUT = 0.00027;
    private static final double COST_PER_1K_OUTPUT = 0.0011;

    private final String apiKey;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    DeepSeekModel(String apiKey) {
        this.apiKey = apiKey;
    }

    @Override
    public AgentLoop.Completion complete(String system, String user) {
        String body = "{\"model\":\"deepseek-chat\",\"messages\":[" +
            "{\"role\":\"system\",\"content\":" + quote(system) + "}," +
            "{\"role\":\"user\",\"content\":" + quote(user) + "}]," +
            "\"temperature\":0,\"max_tokens\":300}";
        HttpRequest request = HttpRequest.newBuilder(URI.create("https://api.deepseek.com/chat/completions"))
            .timeout(Duration.ofSeconds(60))
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer " + apiKey)
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
        try {
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                throw new IllegalStateException("The model answered " + response.statusCode());
            }
            String json = response.body();
            String text = extract(json, "content");
            int in = (int) (json.length() / 4.0);
            int out = (int) (text.length() / 4.0);
            return new AgentLoop.Completion(text, in, out,
                in / 1000.0 * COST_PER_1K_INPUT + out / 1000.0 * COST_PER_1K_OUTPUT);
        } catch (java.io.IOException | InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("The model could not be reached", e);
        }
    }

    private static String quote(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
    }

    private static String extract(String json, String field) {
        int i = json.indexOf("\"" + field + "\":\"");
        if (i < 0) return "";
        i += field.length() + 4;
        StringBuilder out = new StringBuilder();
        while (i < json.length() && json.charAt(i) != '"') {
            if (json.charAt(i) == '\\' && i + 1 < json.length()) i++;
            out.append(json.charAt(i++));
        }
        return out.toString();
    }
}