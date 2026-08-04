import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import swc from 'unplugin-swc'

// Vitest project for the 03-petstore example so its specs surface in the test explorer and in
// `npm test`. No tests exist yet (passWithNoTests). The example uses TC39 decorators (swc transform)
// and Prisma/PostgreSQL — any spec added here must be docker-gated (skip when the DB is down),
// mirroring test/e2e, so the default suite stays green offline.
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
      // Test the working-tree source, not a built dist. Both must be source so the client, the
      // controller, and getRouter share one @caffeinejs/http instance (single router registry).
      '@caffeinejs/http': fileURLToPath(new URL('../../http/index.ts', import.meta.url)),
      '@caffeinejs/testing': fileURLToPath(new URL('../../testing/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'example-petstore',
    include: ['**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    passWithNoTests: true,
  },
})
