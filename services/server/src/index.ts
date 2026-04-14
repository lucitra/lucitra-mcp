/**
 * Lucitra MCP aggregator.
 *
 * Starts a single stdio MCP server that exposes tools from every Lucitra
 * MCP package we care about for local dev automation. Add a new tool
 * family by importing its `registerAllTools` (or specific register*) and
 * calling it below.
 *
 * Invoked by Claude Code via `.mcp.json` — or manually for testing:
 *   pnpm --filter @lucitra/mcp dev
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerAllTools as registerBrowserTools } from '@lucitra/mcp-browser'
import { registerDesktopScreenshotTool } from '@lucitra/mcp-desktop'
import { registerAllTools as registerMacOSTools } from '@lucitra/mcp-macos'

const server = new McpServer({
  name: 'lucitra-mcp',
  version: '0.1.0',
})

// Web browser tools (Playwright): web_navigate, web_click, web_type, web_screenshot, ...
registerBrowserTools(server)

// Desktop screenshot (macOS screencapture + Quartz window queries)
registerDesktopScreenshotTool(server)

// Native macOS tools (AppleScript): desktop_click, desktop_type, desktop_key,
// desktop_focus, desktop_list_windows, desktop_read_window, desktop_run_applescript
registerMacOSTools(server)

const transport = new StdioServerTransport()
await server.connect(transport)

// All logging goes to stderr — stdout is reserved for JSON-RPC traffic.
console.error('lucitra-mcp stdio server running')
