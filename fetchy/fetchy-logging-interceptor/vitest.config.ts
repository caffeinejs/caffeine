import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@caffeinejs/fetchy-logging-interceptor',
    pool: 'threads',
    isolate: false,
    include: ['**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
})
