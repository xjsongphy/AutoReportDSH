import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Linked harness packages resolve their own workspace peers through the
    // harness checkout; no path aliasing is needed here.
    environment: 'node',
  },
})
