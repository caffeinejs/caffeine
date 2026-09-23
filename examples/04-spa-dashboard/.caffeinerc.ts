import { defineConfig } from '@caffeinejs/cli'

export default defineConfig({
  modules: {
    include: ['api/**/*.ts'],
    // The bootstrap files import the generated graph — including them would be circular. Test files declare
    // nothing the container needs, and their top-level describe/it would run outside Vitest.
    exclude: ['**/main.ts', '**/app.ts', '**/*.test.ts'],
    root: 'api',
    // One module per directory directly under api/: each feature is its own.
    depth: 1,
    importExtension: '.js',
  },
})
