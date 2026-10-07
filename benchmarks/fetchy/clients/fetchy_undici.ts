import { newClient } from '@caffeinejs/fetchy'
import { UndiciTransportFactory } from '@caffeinejs/fetchy-undici'

import { BenchAPI } from '../api.js'
import { baseURL, benchBody, benchFilter, benchId } from '../config.js'
import type { BenchClient } from './bench_client.js'

const api = newClient().baseURL(baseURL).transportFactory(new UndiciTransportFactory()).build().create(BenchAPI)

export const fetchyUndiciClient: BenchClient = {
  name: 'fetchy-undici',
  request: () => api.post(benchId, benchFilter, benchBody),
}
