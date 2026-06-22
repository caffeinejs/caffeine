import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
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
    name: 'core',
    include: ['**/*.test.ts'],
    exclude: [
      'node_modules/**',
      'dist/**',
      'decorators/legacy/_tests/**',
      '_tests/memory/**',
      '_tests/deno/**',
      'examples/**',
    ],
    environment: 'node',
    passWithNoTests: true,
    pool: 'forks',
  },
})
