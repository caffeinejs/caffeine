import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'bff',
    pool: 'threads',
    include: ['**/*.test.ts'],
    environment: 'node',
  },
})
