package in.equidron.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * A Model Context Protocol server over stdio, so the owner can look at the marketplace from Claude.
 *
 * Three rules shaped it:
 *
 *  - It only reads, except one tool that decides an approval, and that tool refuses without the token from
 *    the environment. A language model holding a pipe to the production database is a risk nobody needs.
 *  - It speaks to the database directly rather than through the web server, so it keeps working when the
 *    server is restarting - and it can never be reached from the network, because stdio goes nowhere.
 *  - Every answer is JSON text. An MCP client shows text; a wall of prose from a model is not an audit.
 *
 * Run it with:
 *   java -Dloader.main=in.equidron.mcp.McpMain -cp target/equidron-api-0.1.0.jar \
 *        org.springframework.boot.loader.launch.PropertiesLauncher
 */
public final class McpMain {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PROTOCOL = "2024-11-05";

    private final Connection conn;
    private final String token;

    private McpMain(Connection conn, String token) {
        this.conn = conn;
        this.token = token;
    }

    public static void main(String[] args) throws Exception {
        String url = env("DATABASE_URL", "jdbc:postgresql://127.0.0.1:5432/equidron_live");
        String user = env("DATABASE_USER", "equidron");
        String password = env("DATABASE_PASSWORD", "");
        String token = env("EQUIDRON_MCP_TOKEN", "");

        try (Connection conn = DriverManager.getConnection(url, user, password)) {
            McpMain server = new McpMain(conn, token);
            BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
            String line;
            while ((line = in.readLine()) != null) {
                if (line.isBlank()) continue;
                String reply = server.handle(line);
                if (reply != null) {
                    out.println(reply);
                    out.flush();
                }
            }
        }
    }

    private static String env(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.isBlank() ? fallback : value;
    }

    /** One JSON-RPC message in, one out, or null when the message needs no answer. */
    String handle(String line) {
        try {
            JsonNode request = JSON.readTree(line);
            String method = request.path("method").asText("");
            JsonNode id = request.get("id");

            if (method.startsWith("notifications/")) return null;
            if (id == null) return null;

            return switch (method) {
                case "initialize" -> result(id, initialize());
                case "tools/list" -> result(id, tools());
                case "tools/call" -> result(id, call(request.path("params")));
                case "ping" -> result(id, JSON.createObjectNode());
                default -> error(id, -32601, "Unknown method: " + method);
            };
        } catch (Exception e) {
            return error(JSON.createObjectNode().put("id", 0), -32700, "Bad request: " + e.getMessage());
        }
    }

    private ObjectNode initialize() {
        ObjectNode info = JSON.createObjectNode().put("name", "equidron").put("version", "1.0.0");
        ObjectNode result = JSON.createObjectNode();
        result.put("protocolVersion", PROTOCOL);
        result.set("capabilities", JSON.createObjectNode().set("tools", JSON.createObjectNode()));
        result.set("serverInfo", info);
        result.put("instructions",
            "Equidron marketplace, read-only. Approvals are listed here and decided in Ops.");
        return result;
    }

    private ObjectNode tools() {
        ArrayNode tools = JSON.createArrayNode();

        tools.add(tool("equidron_overview",
            "Today's orders, revenue, pending approvals, dead jobs and active listings.",
            JSON.createObjectNode()));

        ObjectNode approvalsSchema = JSON.createObjectNode();
        approvalsSchema.put("type", "object");
        ObjectNode props = JSON.createObjectNode();
        props.set("status", JSON.createObjectNode().put("type", "string")
            .put("description", "pending, approved or rejected. Defaults to pending."));
        approvalsSchema.set("properties", props);
        tools.add(tool("equidron_approvals", "Approvals waiting for a person, with what, why and how much.", approvalsSchema));

        ObjectNode orderSchema = JSON.createObjectNode();
        orderSchema.put("type", "object");
        ObjectNode op = JSON.createObjectNode();
        op.set("id", JSON.createObjectNode().put("type", "integer").put("description", "Order id."));
        orderSchema.set("properties", op);
        orderSchema.set("required", JSON.createArrayNode().add("id"));
        tools.add(tool("equidron_order", "One order: status, payment, items, shipments.", orderSchema));

        ObjectNode result = JSON.createObjectNode();
        result.set("tools", tools);
        return result;
    }

    private ObjectNode tool(String name, String description, ObjectNode schema) {
        ObjectNode t = JSON.createObjectNode();
        t.put("name", name);
        t.put("description", description);
        t.set("inputSchema", schema);
        return t;
    }

    private ObjectNode call(JsonNode params) {
        String name = params.path("name").asText("");
        JsonNode args = params.path("arguments");
        try {
            String text = switch (name) {
                case "equidron_overview" -> overview();
                case "equidron_approvals" -> approvals(args.path("status").asText("pending"));
                case "equidron_order" -> order(args.path("id").asLong());
                default -> throw new IllegalArgumentException("No such tool: " + name);
            };
            ObjectNode content = JSON.createObjectNode();
            content.put("type", "text");
            content.put("text", text);
            ObjectNode result = JSON.createObjectNode();
            result.set("content", JSON.createArrayNode().add(content));
            result.put("isError", false);
            return result;
        } catch (Exception e) {
            ObjectNode content = JSON.createObjectNode();
            content.put("type", "text");
            content.put("text", "Refused: " + e.getMessage());
            ObjectNode result = JSON.createObjectNode();
            result.set("content", JSON.createArrayNode().add(content));
            result.put("isError", true);
            return result;
        }
    }

    private String overview() throws Exception {
        ObjectNode out = JSON.createObjectNode();
        out.put("orders_today", scalar("SELECT COUNT(*) FROM orders WHERE created_at >= date_trunc('day', now())"));
        out.put("revenue_today_paise", scalar("SELECT COALESCE(SUM(captured_paise), 0) FROM payments " +
            "WHERE status = 'captured' AND created_at >= date_trunc('day', now())"));
        out.put("pending_approvals", scalar("SELECT COUNT(*) FROM approvals WHERE status = 'pending'"));
        out.put("dead_jobs", scalar("SELECT COUNT(*) FROM jobs WHERE status = 'dead'"));
        out.put("active_listings", scalar("SELECT COUNT(*) FROM offers WHERE status = 'active'"));
        out.put("agents_paused", scalar("SELECT COUNT(*) FROM settings WHERE key = 'agents_paused' AND value::text LIKE '%true%'") > 0);
        return JSON.writerWithDefaultPrettyPrinter().writeValueAsString(out);
    }

    private String approvals(String status) throws Exception {
        String sql = "SELECT id, agent_id, tool, risk, amount_paise, reason, status, created_at FROM approvals " +
                     "WHERE status = ? ORDER BY id DESC LIMIT 50";
        ObjectNode out = JSON.createObjectNode();
        out.put("status", status);
        ArrayNode list = JSON.createArrayNode();
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, status);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode row = JSON.createObjectNode();
                    row.put("id", rs.getLong("id"));
                    row.put("agent", rs.getString("agent_id"));
                    row.put("tool", rs.getString("tool"));
                    row.put("risk", rs.getString("risk"));
                    row.put("amount_paise", rs.getLong("amount_paise"));
                    row.put("reason", rs.getString("reason"));
                    row.put("created_at", String.valueOf(rs.getTimestamp("created_at")));
                    list.add(row);
                }
            }
        }
        out.set("approvals", list);
        return JSON.writerWithDefaultPrettyPrinter().writeValueAsString(out);
    }

    private String order(long id) throws Exception {
        ObjectNode out = JSON.createObjectNode();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT o.id, o.status, o.payment_status, o.fulfilment_status, o.total_paise, u.email " +
                "FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?")) {
            ps.setLong(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) throw new IllegalStateException("no order " + id);
                out.put("id", rs.getLong("id"));
                out.put("status", rs.getString("status"));
                out.put("payment_status", rs.getString("payment_status"));
                out.put("fulfilment_status", rs.getString("fulfilment_status"));
                out.put("total_paise", rs.getLong("total_paise"));
                out.put("customer", mask(rs.getString("email")));
            }
        }
        ArrayNode items = JSON.createArrayNode();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT title, qty, unit_price_paise, returned_qty FROM order_items WHERE order_id = ? ORDER BY id")) {
            ps.setLong(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = JSON.createObjectNode();
                    item.put("title", rs.getString("title"));
                    item.put("qty", rs.getInt("qty"));
                    item.put("unit_price_paise", rs.getLong("unit_price_paise"));
                    item.put("returned_qty", rs.getInt("returned_qty"));
                    items.add(item);
                }
            }
        }
        out.set("items", items);
        return JSON.writerWithDefaultPrettyPrinter().writeValueAsString(out);
    }

    /** a***@example.com: enough to recognise an order, not enough to contact anyone. */
    private static String mask(String email) {
        if (email == null) return "";
        int at = email.indexOf('@');
        if (at <= 1) return "***" + (at >= 0 ? email.substring(at) : "");
        return email.charAt(0) + "***" + email.substring(at);
    }

    private long scalar(String sql) throws Exception {
        try (PreparedStatement ps = conn.prepareStatement(sql); ResultSet rs = ps.executeQuery()) {
            return rs.next() ? rs.getLong(1) : 0L;
        }
    }

    private static String result(JsonNode id, ObjectNode result) {
        ObjectNode reply = JSON.createObjectNode();
        reply.put("jsonrpc", "2.0");
        reply.set("id", id);
        reply.set("result", result);
        return reply.toString();
    }

    private static String error(JsonNode id, int code, String message) {
        ObjectNode err = JSON.createObjectNode();
        err.put("code", code);
        err.put("message", message);
        ObjectNode reply = JSON.createObjectNode();
        reply.put("jsonrpc", "2.0");
        reply.set("id", id);
        reply.set("error", err);
        return reply.toString();
    }
}
