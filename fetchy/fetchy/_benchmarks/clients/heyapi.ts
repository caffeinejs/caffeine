import { client } from '../generated/heyapi/client.gen.js'
import { postBench } from '../generated/heyapi/index.js'
import { baseURL, benchBody, benchFilter, benchId } from '../config.js'
import type { BenchClient } from './bench_client.js'

client.setConfig({ baseUrl: baseURL })

export const heyapiClient: BenchClient = {
  name: 'heyapi',
  request: () =>
    postBench({
      path: { id: benchId },
      query: { filter: benchFilter },
      body: benchBody,
    }),
}
