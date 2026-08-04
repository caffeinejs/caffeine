import { defineConfig } from '@caffeinejs/cli'

export default defineConfig({
  generate: {
    include: ['src/**/*.ts'],
    // Keep the bootstrap (it imports the generated file — would be circular) and test files
    // (their top-level describe/it run outside Vitest) out of the generated registration.
    exclude: ['**/main.ts', '**/*.test.ts'],
    output: 'src/__caffeine__.gen.ts',
    importExtension: '.js',
  },
})
