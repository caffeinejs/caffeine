import { defineConfig } from '@caffeinejs/cli'

export default defineConfig({
  modules: {
    include: ['src/**/*.ts', 'src/**/*.tsx'],
    // Keep the bootstrap files (they import the generated graph — would be circular) and test files
    // (their top-level describe/it run outside Vitest) out of the generated registration.
    exclude: ['**/main.ts', '**/app.ts', '**/*.test.ts'],
    root: 'src',
    // One module per directory directly under src/: each domain is its own, and `util` gathers what its
    // subdirectories declare. A domain sits one level down, so a deeper stop would bucket it into the root.
    depth: 1,
    importExtension: '.js',
  },
})
