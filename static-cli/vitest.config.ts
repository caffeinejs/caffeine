import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'static-cli',
    include: ['**/*.test.ts'],
    environment: 'node',
  },
})
