import { fileURLToPath } from 'node:url'

import swc from 'unplugin-swc'
import { configDefaults, defineConfig } from 'vitest/config'

// One copy of this package, its source: @caffeinejs/http-node's source imports it by name and must share its modules
// with the suites, kHosting among them. A subpath precedes the bare package, which matches it as a prefix.
export const sourceAliases = [
  { find: '@caffeinejs/http-node', replacement: fileURLToPath(new URL('../http-node/index.ts', import.meta.url)) },
  { find: '@caffeinejs/http/platform', replacement: fileURLToPath(new URL('./platform/index.ts', import.meta.url)) },
  { find: '@caffeinejs/http', replacement: fileURLToPath(new URL('./index.ts', import.meta.url)) },
]

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
  resolve: { alias: sourceAliases },
  test: {
    name: 'http',
    pool: 'threads',
    include: ['**/*.test.ts'],
    // Measured on its own, in a fork with the collector exposed: `npm run test:memory`.
    exclude: [...configDefaults.exclude, '_tests/memory/**'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
