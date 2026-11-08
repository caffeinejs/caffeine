import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'resilience-memory',
    include: ['_tests/memory/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    execArgv: ['--expose-gc'],
  },
})
