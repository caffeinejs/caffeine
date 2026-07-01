import { defineConfig } from '@caffeinejs/cli'

export default defineConfig({
  generate: {
    include: ['src/**.ts'],
    output: 'src/routes.ts',
  },
})
