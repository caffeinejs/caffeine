import { Pool } from 'undici'

import { baseURL, benchBody, benchPath, jsonHeaders } from '../config.js'
import type { BenchClient } from './bench_client.js'

const pool = new Pool(baseURL)

export const undiciClient: BenchClient = {
  name: 'undici',
  request: () =>
    pool
      .request({
        path: benchPath,
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(benchBody),
      })
      .then(({ body }) => body.json()),
}
