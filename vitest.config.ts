import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      './core/vitest.config.ts',
      './core/vitest.leak.config.ts',
      './crema/vitest.config.ts',
      './application/vitest.config.ts',
      './http/vitest.config.ts',
      './testing/vitest.config.ts',
      './plugins/eslint/vitest.config.ts',
    ],
  },
})
