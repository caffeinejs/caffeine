import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['./http/vitest.config.ts', './http-fastify-adapter/vitest.config.ts'],
  },
})
