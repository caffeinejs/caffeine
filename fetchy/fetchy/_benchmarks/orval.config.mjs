export default {
  benchmark: {
    input: './openapi.yaml',
    output: {
      target: './generated/orval/client.ts',
      client: 'fetch',
      mode: 'single',
      override: {
        mutator: {
          path: './custom_fetch.ts',
          name: 'customFetch',
        },
      },
    },
  },
}
