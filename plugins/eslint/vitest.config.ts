import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@caffeinejs/eslint-plugin',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    passWithNoTests: true,
    pool: 'forks',
  },
})
