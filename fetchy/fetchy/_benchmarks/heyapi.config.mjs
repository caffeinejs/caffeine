import { defineConfig } from '@hey-api/openapi-ts'

export default defineConfig({
  input: './_benchmarks/openapi.yaml',
  output: './_benchmarks/generated/heyapi',
  plugins: ['@hey-api/client-fetch', '@hey-api/sdk'],
})
