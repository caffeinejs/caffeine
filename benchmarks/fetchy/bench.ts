import { group, run, summary } from 'mitata'

import { clients } from './clients/index.js'
import { concurrency, port, warmupRounds } from './config.js'
import { spawnServer } from './spawn_server.js'
import { concurrentBench, warmUp } from './utils.js'

const stop = await spawnServer(port)

// A fresh process keeps getting faster for roughly its first 15,000 requests, whichever client sends them. Measured
// cold, the client that runs first reads several milliseconds slower than its place in the ranking.
for (const client of clients) {
  await warmUp(concurrency, warmupRounds, () => client.request())
}

group('POST', () => {
  summary(() => {
    for (const client of clients) {
      concurrentBench(client.name, concurrency, () => client.request())
    }
  })
})

await run({ throw: true })

stop()
