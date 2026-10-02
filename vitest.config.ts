import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * AutoReport keeps its workflow log under the harness home, so the suite pins
 * `$DSH_HOME` to a temp directory before any test runs. Without this a fixture
 * that resolved the default home would write into the developer's real
 * `~/.dsh`. Each worker process gets its own directory, which is enough: tests
 * are isolated per file, and the workspace-keyed path separates tests within
 * one file.
 */
const dshHome = mkdtempSync(join(tmpdir(), 'autoreport-vitest-home-'))

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    // A linked harness package carries its own React copy beside its sources.
    // Rendering one of its stateful components (the JSON inspector tree, say)
    // under @testing-library would then run on a React the test renderer knows
    // nothing about, so the suite pins a single copy.
    dedupe: ['react', 'react-dom'],
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Linked harness packages resolve their own workspace peers through the
    // harness checkout; no path aliasing is needed here.
    environment: 'node',
    env: {
      DSH_HOME: dshHome,
    },
  },
})
