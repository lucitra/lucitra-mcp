import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
  // Playwright is pulled in transitively by @lucitra/mcp-browser; keep it
  // external so we don't bundle the massive browser driver.
  external: ['playwright'],
  banner: {
    js: '#!/usr/bin/env node',
  },
})
