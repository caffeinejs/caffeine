import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      './core/vitest.config.ts',
      './core/vitest.leak.config.ts',
      './application/vitest.config.ts',
      './http/vitest.config.ts',
      './fetchy/fetchy/vitest.config.ts',
      './fetchy/fetchy-logging-interceptor/vitest.config.ts',
      './fetchy/fetchy-undici/vitest.config.ts',
      './testing/vitest.config.ts',
      './plugins/eslint/vitest.config.ts',
      './config/vitest.config.ts',
    ],
  },
})
