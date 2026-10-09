import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    swc.vite({
      // Vite already applied the dist file's source map; SWC must not apply it again.
      inputSourceMap: false,
      jsc: {
        parser: { syntax: 'typescript', tsx: true, decorators: true },
        transform: {
          // fetchy keeps what its decorators declare on `context.metadata`, as this version passes it.
          decoratorVersion: '2023-11',
          react: { runtime: 'automatic', importSource: '@kitajs/html', throwIfNamespace: false },
        },
        target: 'es2022',
      },
    }),
  ],
  // @ts-expect-error — oxc is an experimental Vitest option not yet in Vite's types
  oxc: false,
  test: {
    name: 'devtools-ui',
    pool: 'threads',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
