import { UndiciCallFactory } from '@caffeinejs/fetchy-undici'

import { newClient } from '../../client_builder.js'
import { BenchAPI } from '../api.js'
import { baseURL, benchBody, benchFilter, benchId } from '../config.js'
import type { BenchClient } from './bench_client.js'

const api = newClient().baseURL(baseURL).callFactory(new UndiciCallFactory()).build().create(BenchAPI)

export const fetchyUndiciClient: BenchClient = {
  name: 'fetchy-undici',
  request: () => api.post(benchId, benchFilter, benchBody),
}
