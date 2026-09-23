import { fileURLToPath } from 'node:url'

import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// Vitest project for the 04-spa-dashboard example, so its specs run in the root `npm test` and show up in the
// test explorer. `globalSetup` builds the front end when it is missing, so a fresh clone can run the suite
// without being told to build first — the specs serve real files and assert real compressed siblings.
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
      // Test the working-tree source, not a built dist. Everything that touches the router registry must be
      // source, so the controllers, the routers and @APIGroup all share one instance of it — the registry is a
      // module-level WeakMap, and a second copy silently loses every registration made against the first.
      //
      // Order matters: a string alias matches by prefix, so the subpath entry has to precede the bare package.
      '@caffeinejs/http/decorators/registrar': fileURLToPath(
        new URL('../../http/decorators/registrar/index.ts', import.meta.url),
      ),
      '@caffeinejs/http': fileURLToPath(new URL('../../http/index.ts', import.meta.url)),
      '@caffeinejs/openapi': fileURLToPath(new URL('../../openapi/index.ts', import.meta.url)),
      // Source too: `ErrSendFileUnavailable` extends a class the error pipeline matches on, and a copy
      // resolved from dist would extend a different one.
      '@caffeinejs/static': fileURLToPath(new URL('../../static/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'example-spa-dashboard',
    globalSetup: ['./vitest.globalsetup.ts'],
    include: ['api/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    passWithNoTests: true,
  },
})
