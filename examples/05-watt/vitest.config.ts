import { defineConfig } from 'vitest/config'

// Vitest project for the 05-watt example, so its specs run in the root `npm test` and show up in the test explorer.
// The runtime spec starts the compiled example under Watt, which loads each entry module itself, outside Vite:
// `globalSetup` compiles the example first, against the built framework packages.
export default defineConfig({
  test: {
    name: 'example-watt',
    globalSetup: ['./vitest.globalsetup.ts'],
    include: ['*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
