import { defineConfig } from '@caffeinejs/cli'

export default defineConfig({
  modules: {
    include: ['src/**/*.ts'],
    // The bootstrap files import the generated graph — including them would be circular.
    exclude: ['**/main.ts', '**/app.ts', '**/app.di.ts'],
    root: 'src',
    importExtension: '.js',
  },
})
