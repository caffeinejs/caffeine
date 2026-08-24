import { defineConfig } from 'vitest/config'
import swc from 'unplugin-swc'

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
    name: 'messaging',
    include: ['**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
