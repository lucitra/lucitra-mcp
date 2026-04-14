# lucitra-mcp

Lucitra's local-dev MCP tool collection. A single stdio MCP server that gives Claude Code (and other MCP clients) a unified set of tools for browser automation, desktop screenshots, and native macOS app control.

## What's inside

| Package | Role | Source |
|---------|------|--------|
| `@lucitra/mcp` | **Aggregator** — the single stdio binary you point MCP clients at. | `services/server/` |
| `@lucitra/mcp-macos` | Native macOS automation: click / double-click / drag / scroll / mouse-move, type, key, focus, app launch / quit / frontmost, menu-bar click, window list / move / resize, read window via Accessibility, clipboard get/set, region screenshot, open URL / path, notification, run arbitrary AppleScript. | `packages/mcp-macos/` |
| `@lucitra/mcp-browser` | Playwright-driven web automation. | [lucitra/mcp-browser](https://github.com/lucitra/mcp-browser) (npm dep) |
| `@lucitra/mcp-desktop` | macOS desktop screenshot (full screen or app window). | [lucitra/mcp-desktop](https://github.com/lucitra/mcp-desktop) (npm dep) |

The aggregator depends on the two external packages via npm and on `@lucitra/mcp-macos` via the pnpm workspace.

## Usage with Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "lucitra": {
      "command": "node",
      "args": ["/path/to/lucitra-mcp/services/server/dist/index.js"]
    }
  }
}
```

Or, once published to npm:

```json
{
  "mcpServers": {
    "lucitra": {
      "command": "npx",
      "args": ["-y", "@lucitra/mcp"]
    }
  }
}
```

## Development

```bash
pnpm install
pnpm build
pnpm --filter @lucitra/mcp dev  # run the aggregator in watch mode
```

## macOS permissions

The `mcp-macos` tools need Accessibility + Automation permission for the process running the MCP server (Node, Terminal, or iTerm, depending on how you launched it). macOS prompts on first use — approve in System Settings → Privacy & Security → Accessibility / Automation. If a tool returns an error mentioning `-1743` or `not authorized`, that's the cause.

## Adding a new tool family

1. Create `packages/mcp-<name>/` following the pattern of `packages/mcp-macos/`.
2. Export a `registerAllTools(server)` function from the package.
3. Import and call it in `services/server/src/index.ts`.
4. `pnpm build` and restart the MCP client.
