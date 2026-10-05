import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

const common = {
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  splitting: false,
  minify: false
} as const

export default defineConfig([
  {
    ...common,
    entry: ['src/index.ts'],
    sourcemap: true,
    // Both builds run at once into dist/: spare the extension the other one writes.
    clean: ['!codeg-bridge.mjs'],
    // `initialize` reports this version; baked in so it holds however the package is laid out.
    define: { __CODEG_PI_ACP_VERSION__: JSON.stringify(version) },
    banner: {
      js: '#!/usr/bin/env node'
    }
  },
  {
    ...common,
    // The pi extension the adapter loads with `pi -e` (src/acp/mcp-bridge.ts expects it
    // next to the adapter). pi resolves no packages for it: node built-ins only.
    entry: { 'codeg-bridge': 'src/pi-extension/codeg-bridge.ts' },
    outExtension: () => ({ js: '.mjs' })
  }
])
