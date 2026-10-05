import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * AutoReport keeps its workflow log under the harness home, so the suite pins
 * `$DSH_HOME` to a temp directory before any test runs. Without this a fixture
 * that resolved the default home would write into the developer's real
 * `~/.dsh`. The run shares this home, while each fixture's unique workspace
 * keeps workflow logs separate across files and workers.
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
    globalSetup: ['./tests/helpers/build-setup.ts'],
    // Use every available CPU, including the second CPU on small CI runners
    // that Vitest's default (CPU count - 1) would otherwise leave unused.
    // Keep process/file isolation: fixtures mutate env, registries and timers.
    pool: 'forks',
    isolate: true,
    fileParallelism: true,
    maxWorkers: '100%',
    minWorkers: 1,
    // Linked harness packages resolve their own workspace peers through the
    // harness checkout; no path aliasing is needed here.
    environment: 'node',
    env: {
      DSH_HOME: dshHome,
    },
  },
})
