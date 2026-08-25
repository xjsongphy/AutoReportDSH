import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Linked harness packages resolve their own workspace peers through the
    // harness checkout; no path aliasing is needed here.
    environment: 'node',
  },
})
