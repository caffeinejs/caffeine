import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // @ts-expect-error — oxc is an experimental Vitest option not yet in Vite's types
  oxc: false,
  plugins: [
    swc.vite({
      // Vite already applied the dist file's source map; SWC must not apply it again.
      inputSourceMap: false,
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        target: 'esnext',
        transform: { decoratorVersion: '2023-11' },
      },
    }),
  ],
  test: {
    include: ['_tests/memory/**/*.test.ts'],
    pool: 'forks',
    execArgv: ['--expose-gc'],
  },
})
