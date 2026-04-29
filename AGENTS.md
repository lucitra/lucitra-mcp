# lucitra-mcp

Codex guidance for Lucitra's local-dev MCP tool collection.

## Purpose

Stdio MCP aggregator for browser automation, desktop screenshots, and native macOS app control.

## Structure

- `services/server/`: aggregator server
- `packages/mcp-macos/`: native macOS automation tools
- External package dependencies provide browser and desktop screenshot tool families

## Development

```sh
pnpm install
pnpm build
pnpm --filter @lucitra/mcp dev
```

## Rules

- Keep MCP tool schemas stable and documented.
- macOS automation requires Accessibility and Automation permissions; surface permission failures clearly.
- Avoid adding arbitrary execution behavior unless explicitly scoped and reviewed.
- When adding a tool family, register it through the aggregator and update usage docs.
