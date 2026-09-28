import { defineConfig } from '@hey-api/openapi-ts'

export default defineConfig({
  input: './fetchy/openapi.yaml',
  output: './fetchy/generated/heyapi',
  plugins: ['@hey-api/client-fetch', '@hey-api/sdk'],
})
