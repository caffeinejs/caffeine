import { fileURLToPath } from 'node:url'

import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// Opt-in e2e project (not in the root vitest projects list). Runs the OIDC/OAuth2 flows against
// the dockerized Spring Authorization Server (test/services/oauthserver), distlock against the
// dockerized Redis and Valkey (test/services/redis), and configuration against the dockerized Spring
// Cloud Config Server (test/services/configserver). Specs skip when their service is not up.
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
      // Test the working-tree source, not a built dist.
      '@caffeinejs/http': fileURLToPath(new URL('../../http/index.ts', import.meta.url)),
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
    testTimeout: 30000,
    hookTimeout: 30000,
    passWithNoTests: true,
  },
})
