/**
 * Emit the browser settings-card bundle in DSH's lazy-CJS factory format.
 *
 * The in-tree `clientBundle` tsdown preset is not published, so this package
 * reproduces the loader handoff: `window.__ModuleLoader__.load({ id, factory })`
 * with platform modules left external for the web shell's module table.
 *
 * @module autoreportdsh/build-client
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'dist', 'client.js')
const packageId = 'autoreportdsh'

/** Specifiers the DSH web shell seeds; requiring them from the factory is the point. */
const externals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
]

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
