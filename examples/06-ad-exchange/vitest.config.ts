import { fileURLToPath } from 'node:url'

import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// Vitest project for the ad exchange example, so its specs run in `npm test`. They boot the real application, `test`
// profile, against fake DSPs on real sockets: no Docker and no VLatte. The example uses TC39 decorators, through SWC.
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
  oxc: false,
  resolve: {
    alias: {
      // Test the working-tree source of the HTTP package, so the controllers and the server share one router
      // registry. The subpath entries precede the bare package: a string alias matches by prefix.
      '@caffeinejs/http/decorators/registrar': fileURLToPath(
        new URL('../../http/decorators/registrar/index.ts', import.meta.url),
      ),
      '@caffeinejs/http/fastify': fileURLToPath(new URL('../../http/platform/fastify/index.ts', import.meta.url)),
      '@caffeinejs/http': fileURLToPath(new URL('../../http/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'example-ad-exchange',
    // The `test` profile layers config/application-test.yaml, with an OS-assigned port, over the base file.
    env: { CAFFEINE_PROFILES: 'test' },
    include: ['**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
  },
})
