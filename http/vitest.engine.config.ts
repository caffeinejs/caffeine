import { fileURLToPath } from 'node:url'

import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// The suites that run on both servers: each imports `createWebApplication` from the Fastify entry, which this project
// resolves to the fetch application's. A copy of `vitest.config.ts`'s options, not a merge, which would concatenate
// `include` and run every suite.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
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
    alias: [
      {
        find: /^\.\.\/platform\/fastify\/index\.js$/,
        replacement: fileURLToPath(new URL('./_tests/engine_entry.ts', import.meta.url)),
      },
    ],
  },
  test: {
    name: 'http (engine)',
    pool: 'threads',
    include: [
      '_tests/args_builder.test.ts',
      '_tests/context_headers.test.ts',
      '_tests/header.test.ts',
      '_tests/prefix.test.ts',
      '_tests/timeout.test.ts',
      '_tests/status.test.ts',
      '_tests/redirect.test.ts',
      '_tests/not_found_catch.test.ts',
      '_tests/versioning_decorated_prefix.test.ts',
    ],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
