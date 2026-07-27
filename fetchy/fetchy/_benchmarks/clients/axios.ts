import axios from 'axios'

import { baseURL, benchBody, benchPath, jsonHeaders } from '../config.js'
import type { BenchClient } from './bench_client.js'

const url = `${baseURL}${benchPath}`

export const axiosClient: BenchClient = {
  name: 'axios',
  request: () => axios.post(url, benchBody, { headers: jsonHeaders }),
}
