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
          decoratorVersion: '2022-03',
          react: { runtime: 'automatic', importSource: '@kitajs/html' },
        },
        target: 'es2022',
      },
    }),
  ],
  // @ts-expect-error — oxc is an experimental Vitest option not yet in Vite's types
  oxc: false,
  test: {
    name: 'devtools-ui',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    environment: 'node',
    passWithNoTests: true,
  },
})
