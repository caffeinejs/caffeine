import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@caffeinejs/fetchy-undici',
    include: ['**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
})
