import { group, run, summary } from 'mitata'

import { clients } from './clients/index.js'
import { concurrency, port } from './config.js'
import { spawnServer } from './spawn_server.js'
import { concurrentBench } from './utils.js'

const stop = await spawnServer(port)

group('POST', () => {
  summary(() => {
    for (const client of clients) {
      concurrentBench(client.name, concurrency, () => client.request())
    }
  })
})

await run({ throw: true })

stop()
