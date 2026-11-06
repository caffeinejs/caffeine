import { fileURLToPath } from 'node:url'

import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// Opt-in e2e project (not in the root vitest projects list). Runs authentication and authorization over a real
// socket — against the dockerized Spring Authorization Server (test/services/oauthserver) and Redis
// (test/services/redis) where a spec needs them — distlock and the caching Redis store
// (caching/store/redis/redis.e2e.ts) against the dockerized Redis and Valkey, the HTTP cache through a staged
// Redis outage (caching.chaos.e2e.ts), and configuration against the dockerized Spring Cloud Config Server
// (test/services/configserver), and the resilience strategies against a scripted dependency on a local socket
// (resilience_*.e2e.ts), which needs no service. Specs skip when their service is not up, unless
// CAFFEINE_E2E_STRICT=1, which fails them instead.
export default defineConfig({
  plugins: [
    swc.vite({
      // Vite already applied the dist file's source map; SWC must not apply it again.
      inputSourceMap: false,
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorVersion: '2022-03' },
        target: 'es2022',
      },
    }),
  ],
  // @ts-expect-error — oxc is an experimental Vitest option not yet in Vite's types
  oxc: false,
  resolve: {
    alias: {
      // Test the working-tree source, not a built dist. A string alias matches by prefix, so the subpath goes first.
      '@caffeinejs/http/fastify': fileURLToPath(new URL('../../http/platform/fastify/index.ts', import.meta.url)),
      // One copy of the route registry: the resilience HTTP check reads the routes the source decorators wrote.
      '@caffeinejs/http/decorators/registrar': fileURLToPath(
        new URL('../../http/decorators/registrar/index.ts', import.meta.url),
      ),
      '@caffeinejs/http': fileURLToPath(new URL('../../http/index.ts', import.meta.url)),
      ...Object.fromEntries(
        ['aop', 'bulkhead', 'circuitbreaker', 'fallback', 'http', 'otel', 'ratelimiter', 'retry', 'timelimiter'].map(
          subpath => [
            `@caffeinejs/resilience/${subpath}`,
            fileURLToPath(new URL(`../../resilience/${subpath}/index.ts`, import.meta.url)),
          ],
        ),
      ),
      '@caffeinejs/resilience': fileURLToPath(new URL('../../resilience/index.ts', import.meta.url)),
      '@caffeinejs/distlock/backend/redis': fileURLToPath(
        new URL('../../distlock/backend/redis/index.ts', import.meta.url),
      ),
      '@caffeinejs/distlock': fileURLToPath(new URL('../../distlock/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'e2e',
    include: ['**/*.e2e.ts'],
    environment: 'node',
    // One file at a time: the sign-in specs listen on the one port the identity provider has registered as their
    // redirect URI, so two of them cannot hold it at once.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    passWithNoTests: true,
  },
})
