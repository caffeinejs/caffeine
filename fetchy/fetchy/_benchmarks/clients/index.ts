import { axiosClient } from './axios.js'
import type { BenchClient } from './bench_client.js'
import { fetchClient } from './fetch.js'
import { fetchyClient } from './fetchy.js'
import { fetchyUndiciClient } from './fetchy_undici.js'
import { gotClient } from './got.js'
import { heyapiClient } from './heyapi.js'
import { orvalClient } from './orval.js'
import { undiciClient } from './undici.js'

/**
 * Every client benchmarked by `post.bench.ts`. To add another library: implement a new
 * `BenchClient` in this directory and add it here — nothing else needs to change.
 */
export const clients: BenchClient[] = [
  fetchyClient,
  fetchClient,
  axiosClient,
  gotClient,
  undiciClient,
  fetchyUndiciClient,
  heyapiClient,
  orvalClient,
]
