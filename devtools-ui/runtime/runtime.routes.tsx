import { Router } from '@caffeinejs/http'

import { DevToolsAPI } from '../api.js'
import { kConfig } from '../app.config.js'
import { KeyValue, bytes } from '../shared/components/index.js'
import { page } from '../shared/layout/index.js'

/** The process at the moment the page was asked for. */
export const runtimeRouter = new Router('/runtime')
  .inject({ api: DevToolsAPI, config: kConfig })
  .get('/', async (_ctx, { api, config }) => {
    const runtime = await api.runtime()

    return page(api, config, {
      title: 'Runtime',
      active: '/runtime',
      body: (
        <>
          <h2>Event loop</h2>
          <KeyValue
            rows={[
              ['busy since start', percent(runtime.eventLoop.sinceStart)],
              ['busy since last read', percent(runtime.eventLoop.sincePrevious)],
            ]}
          />
          <h2>Memory</h2>
          <KeyValue rows={Object.entries(runtime.memory).map(([key, value]) => [key, bytes(value)] as const)} />
          <h2>Heap</h2>
          <KeyValue
            rows={[
              ['used', bytes(runtime.heap.used_heap_size)],
              ['total', bytes(runtime.heap.total_heap_size)],
              ['limit', bytes(runtime.heap.heap_size_limit)],
            ]}
          />
          <h2>CPU</h2>
          <KeyValue
            rows={[
              ['user', `${(runtime.resources.userCPUTime / 1000).toFixed(0)} ms`],
              ['system', `${(runtime.resources.systemCPUTime / 1000).toFixed(0)} ms`],
              ['max RSS', bytes(runtime.resources.maxRSS * 1024)],
            ]}
          />
          <h2>Active resources</h2>
          <KeyValue rows={Object.entries(runtime.activeResources)} />
        </>
      ),
    })
  })

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}
