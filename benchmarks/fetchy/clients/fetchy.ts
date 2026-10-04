import { newClient } from '@caffeinejs/fetchy'

import { BenchAPI } from '../api.js'
import { baseURL, benchBody, benchFilter, benchId } from '../config.js'
import type { BenchClient } from './bench_client.js'

const api = newClient().baseURL(baseURL).build().create(BenchAPI)

export const fetchyClient: BenchClient = {
  name: 'fetchy',
  request: () => api.post(benchId, benchFilter, benchBody),
}

export const fetchyMethodClient: BenchClient = {
  name: 'fetchy-method',
  request: () => api.postMethod(benchId, benchFilter, benchBody),
}
