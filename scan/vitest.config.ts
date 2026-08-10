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
    name: 'scan',
    include: ['**/*.test.ts'],
    exclude: [
      'node_modules/**',
      'dist/**',
    ],
    environment: 'node',
    passWithNoTests: true,
    pool: 'forks',
  },
})
