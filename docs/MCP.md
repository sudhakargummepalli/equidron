# MCP server (EQ-114)

A small Model Context Protocol server that lets the owner ask Claude about the marketplace: today's orders
and money, the approvals waiting for a person, any single order.

It is **read-only on purpose**. Deciding an approval means running the approved action; a tool that only
changed the status would leave a record saying "approved" for work nobody did, which is worse than no tool.
Approvals are decided in Ops, where the action runs.

## Start it

```powershell
java -Dloader.main=in.equidron.mcp.McpMain -cp java-backend/target/equidron-api-0.1.0.jar `
     org.springframework.boot.loader.launch.PropertiesLauncher
```

It reads `DATABASE_URL`, `DATABASE_USER` and `DATABASE_PASSWORD` from the environment (the same values the
server uses) and speaks JSON-RPC over stdin/stdout. It never opens a port, so it cannot be reached from the
network.

## Point Claude Desktop at it

Add this to `claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows):

```json
{
  "mcpServers": {
    "equidron": {
      "command": "java",
      "args": [
        "-Dloader.main=in.equidron.mcp.McpMain",
        "-cp", "C:\\path\\to\\equidron\\java-backend\\target\\equidron-api-0.1.0.jar",
        "org.springframework.boot.loader.launch.PropertiesLauncher"
      ],
      "env": {
        "DATABASE_URL": "jdbc:postgresql://127.0.0.1:5432/equidron_live",
        "DATABASE_USER": "equidron",
        "DATABASE_PASSWORD": "equidron-local"
      }
    }
  }
}
```

Restart Claude Desktop; the tools appear under the connector icon.

## Tools

| Tool | Answers |
|---|---|
| `equidron_overview` | orders today, revenue today, pending approvals, dead jobs, active listings, whether agents are paused |
| `equidron_approvals` | the approvals waiting, with agent, tool, risk, amount and reason |
| `equidron_order` | one order: status, payment, items, returned quantities, with the customer's email masked |

## What it will not do

- Change anything. There is no write tool.
- Show an unmasked email address; `a***@example.com` is enough to recognise an order.
- Talk to the web server. It reads the database directly, so a restarting server does not break it, and it
  cannot be used to reach the API without a session.