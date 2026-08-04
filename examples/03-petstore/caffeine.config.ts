import { defineConfig } from '@caffeinejs/cli'

export default defineConfig({
  generate: {
    include: ['src/**/*.ts'],
    // Keep the bootstrap files (they import the generated file — would be circular) and test files
    // (their top-level describe/it run outside Vitest) out of the generated registration.
    exclude: ['**/main.ts', '**/app.ts', '**/app.container.ts', '**/*.test.ts'],
    output: 'src/__caffeine__.gen.ts',
    importExtension: '.js',
  },
})
