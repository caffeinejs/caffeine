import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['./core/vitest.config.ts', './http/vitest.config.ts', './http-fastify-adapter/vitest.config.ts'],
  },
})
