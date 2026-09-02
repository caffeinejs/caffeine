import { defineConfig } from 'vitest/config'
import swc from 'unplugin-swc'

export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', tsx: true, decorators: true },
        transform: {
          decoratorVersion: '2022-03',
          react: { runtime: 'automatic', importSource: '@kitajs/html', throwIfNamespace: false },
        },
        target: 'es2022',
      },
    }),
  ],
  // @ts-expect-error — oxc is an experimental Vitest option not yet in Vite's types
  oxc: false,
  test: {
    name: 'html',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
