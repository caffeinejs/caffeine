import { benchBody, benchFilter, benchId } from '../config.js'
import { postBench } from '../generated/orval/client.js'
import type { BenchClient } from './bench_client.js'

export const orvalClient: BenchClient = {
  name: 'orval',
  request: () => postBench(benchId, benchBody, { filter: benchFilter }),
}
