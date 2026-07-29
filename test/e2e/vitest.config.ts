import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import swc from 'unplugin-swc'

// Opt-in e2e project (not in the root vitest projects list). Runs the OIDC/OAuth2 flows against
// the dockerized Spring Authorization Server (test/services/oauthserver). Specs skip when it is not up.
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorVersion: '2022-03' },
        target: 'es2022',
      },
    }),
  ],
  oxc: false,
  resolve: {
    alias: {
      // Test the working-tree source, not a built dist.
      '@caffeinejs/http': fileURLToPath(new URL('../../http/index.ts', import.meta.url)),
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
