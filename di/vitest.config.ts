import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // @ts-expect-error — oxc is an experimental Vitest option not yet in Vite's types
  oxc: false,
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        target: 'esnext',
        transform: { decoratorVersion: '2023-11' },
      },
    }),
  ],
  test: {
    setupFiles: ['./_polyfill.ts'],
    name: 'core',
    pool: 'threads',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', '_tests/memory/**', '_tests/deno/**', 'examples/**'],
    environment: 'node',
    passWithNoTests: true,
  },
})
