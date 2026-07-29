import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorVersion: '2023-11' },
        target: 'es2022',
      },
    }),
  ],
  oxc: false,
  test: {
    name: 'config',
    include: ['**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
})
