import got from 'got'

import { baseURL, benchBody, benchPath } from '../config.js'
import type { BenchClient } from './bench_client.js'

const url = `${baseURL}${benchPath}`

export const gotClient: BenchClient = {
  name: 'got',
  request: () => got.post(url, { json: benchBody, retry: { limit: 0 } }).json(),
}
