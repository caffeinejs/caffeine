import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'fetchy',
    include: ['**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
})
