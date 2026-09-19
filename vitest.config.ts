import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: {
      junit: './coverage/junit.xml',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      exclude: ['examples/**', '**/*.testkit.ts', '**/dist/**'],
    },
    pool: 'threads',
    maxWorkers: 4,
    experimental: {
      fsModuleCache: true,
    },
    projects: [
      './di/vitest.config.ts',
      './di/vitest.leak.config.ts',
      './scan/vitest.config.ts',
      './std/vitest.config.ts',
      './http/vitest.config.ts',
      './caching/vitest.config.ts',
      './html/vitest.config.ts',
      './multipart/vitest.config.ts',
      './view/vitest.config.ts',
      './static/vitest.config.ts',
      './openapi/vitest.config.ts',
      './messaging/vitest.config.ts',
      './kafka/vitest.config.ts',
      './distlock/vitest.config.ts',
      './resilience/vitest.config.ts',
      './fetchy/fetchy/vitest.config.ts',
      './fetchy/fetchy-logging-interceptor/vitest.config.ts',
      './fetchy/fetchy-undici/vitest.config.ts',
      './testing/vitest.config.ts',
      './brewer/vitest.config.ts',
      './plugins/eslint/vitest.config.ts',
      './examples/03-petstore/vitest.config.ts',
      './test/vitest.config.ts',
    ],
  },
})
