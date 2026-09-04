import { defineConfig } from '@caffeinejs/cli'

export default defineConfig({
  modules: {
    include: ['src/**/*.ts'],
    exclude: ['**/main.ts', '**/*.test.ts'],
    root: 'src',
  },
})
