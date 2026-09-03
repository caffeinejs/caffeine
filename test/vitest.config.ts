import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import swc from 'unplugin-swc'

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
  resolve: {
    alias: {
      '@caffeinejs/di': fileURLToPath(new URL('../di/index.ts', import.meta.url)),
    },
  },
  test: {
    setupFiles: ['../di/_polyfill.ts'],
    name: 'test',
    include: ['**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    pool: 'forks',
  },
})
