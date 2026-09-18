import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'resilience',
    pool: 'threads',
    include: ['**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
})
