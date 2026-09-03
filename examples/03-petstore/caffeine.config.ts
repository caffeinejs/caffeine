import { defineConfig } from '@caffeinejs/cli'

export default defineConfig({
  moduleGraph: {
    include: ['src/**/*.ts'],
    // Keep the bootstrap files (they import the generated graph — would be circular) and test files
    // (their top-level describe/it run outside Vitest) out of the generated registration.
    exclude: ['**/main.ts', '**/app.ts', '**/app.container.ts', '**/*.test.ts'],
    root: 'src',
    depth: 2,
    importExtension: '.js',
  },
})
