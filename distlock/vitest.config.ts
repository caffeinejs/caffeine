import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

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
  // @ts-expect-error — oxc is an experimental Vitest option not yet in Vite's types
  oxc: false,
  test: {
    name: 'distlock',
    pool: 'threads',
    include: ['**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
