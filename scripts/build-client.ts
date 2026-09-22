/**
 * Emit the browser settings-card bundle in DSH's lazy-CJS factory format.
 *
 * The in-tree `clientBundle` tsdown preset is not published, so this package
 * reproduces the loader handoff: `window.__ModuleLoader__.load({ id, factory })`
 * with platform modules left external for the web shell's module table.
 *
 * @module autoreport/build-client
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'dist', 'client.js')
const packageId = 'dsh-autoreport'

/** Specifiers the DSH web shell seeds; requiring them from the factory is the point. */
const externals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * Specifiers the bundle must reach for at runtime, and those it must not
 * mention at all. A plugin bundle stays usable for TYPES only: its CSS-module
 * imports would not survive this pipeline, and requiring one would pull a
 * second copy of a plugin the shell already loaded.
 */
const required = ['@deepseek-ai/dsh-client-ui-primitives']
const forbidden = [
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@deepseek-ai/dsh-client-ui-conversation',
]

/**
 * Check the emitted bundle against the purity contract.
 * @param bundle - the built bundle source.
 * @throws {Error} when a required specifier is missing or a forbidden one appears.
 */
function assertPurity(bundle: string): void {
  for (const specifier of required) {
    if (!bundle.includes(`require(${JSON.stringify(specifier)})`)) {
      throw new Error(`client bundle purity: expected a require of ${specifier}`)
    }
  }
  for (const specifier of forbidden) {
    if (bundle.includes(specifier)) {
      throw new Error(`client bundle purity: ${specifier} leaked into the bundle (import it with \`import type\`)`)
    }
  }
}

mkdirSync(dirname(outfile), { recursive: true })

await esbuild.build({
  absWorkingDir: root,
  entryPoints: [resolve(root, 'src/client/index.ts')],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  jsx: 'automatic',
  sourcemap: true,
  external: externals,
  logLevel: 'info',
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

assertPurity(readFileSync(outfile, 'utf8'))
