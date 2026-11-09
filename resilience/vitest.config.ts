import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'resilience',
    pool: 'threads',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', '_tests/memory/**'],
    environment: 'node',
    passWithNoTests: true,
  },
})
