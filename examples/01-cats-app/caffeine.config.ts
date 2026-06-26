import { defineConfig } from '@caffeinejs/cli'

export default defineConfig({
  generate: {
    include: ['src/**/*.ts'],
    exclude: ['**/__caffeine__.gen.ts'],
    output: 'src/__caffeine__.gen.ts',
    importExtension: '.js',
  },
})
