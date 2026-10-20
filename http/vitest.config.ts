import swc from 'unplugin-swc'
import { configDefaults, defineConfig } from 'vitest/config'

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
