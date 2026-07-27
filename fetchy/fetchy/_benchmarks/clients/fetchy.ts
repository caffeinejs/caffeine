import { newClient } from '../../client_builder.js'
import { BenchAPI } from '../api.js'
import { baseURL, benchBody, benchFilter, benchId } from '../config.js'
import type { BenchClient } from './bench_client.js'

const api = newClient().baseURL(baseURL).build().create(BenchAPI)

export const fetchyClient: BenchClient = {
  name: 'fetchy',
  request: () => api.post(benchId, benchFilter, benchBody),
}
