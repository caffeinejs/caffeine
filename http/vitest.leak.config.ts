import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

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
    name: 'http-memory',
    include: ['_tests/memory/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    execArgv: ['--expose-gc'],
    testTimeout: 120000,
    hookTimeout: 60000,
  },
})
