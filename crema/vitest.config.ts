import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'crema',
    include: ['**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
})
