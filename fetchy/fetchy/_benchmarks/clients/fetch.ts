import { baseURL, benchBody, benchPath, jsonHeaders } from '../config.js'
import type { BenchClient } from './bench_client.js'

const url = `${baseURL}${benchPath}`

export const fetchClient: BenchClient = {
  name: 'fetch',
  request: () =>
    fetch(url, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(benchBody),
    }).then(response => response.json()),
}
