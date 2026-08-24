import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      './di/vitest.config.ts',
      './di/vitest.leak.config.ts',
      './scan/vitest.config.ts',
      './std/vitest.config.ts',
      './http/vitest.config.ts',
      './view/vitest.config.ts',
      './static/vitest.config.ts',
      './openapi/vitest.config.ts',
      './kafka/vitest.config.ts',
      './fetchy/fetchy/vitest.config.ts',
      './fetchy/fetchy-logging-interceptor/vitest.config.ts',
      './fetchy/fetchy-undici/vitest.config.ts',
      './testing/vitest.config.ts',
      './plugins/eslint/vitest.config.ts',
      './examples/03-petstore/vitest.config.ts',
      './test/vitest.config.ts',
    ],
  },
})
