import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      './core/vitest.config.ts',
      './core/vitest.leak.config.ts',
      './http/vitest.config.ts',
      './http-fastify/vitest.config.ts',
      './http-hono/vitest.config.ts',
      './testing/vitest.config.ts',
    ],
  },
})
