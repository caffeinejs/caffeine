import { newConfiguration, RunInfoContrib } from '@caffeinejs/application'
import { loadConfig } from '@caffeinejs/application/config'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { $t } from '@caffeinejs/application/schema'
import { CaffeineIoC } from '@caffeinejs/di'
import { Second } from '@caffeinejs/std/duration'
import { testClient } from '@caffeinejs/testing/http'
import { describe, expect, it } from 'vitest'

import { infoRouter } from './info.route.js'

/** What an operator asks first of a running process: which application, under which profiles, on what. */
describe('infoRouter', () => {
  it('names the application, its profiles, what its features reported and the process it runs in', async () => {
    const store = await loadConfig(
      newConfiguration($t.Object({}))
        .source(new InlineConfigSource({ caffeine: { name: 'petstore' } }))
        .build().config,
      { profiles: ['staging'], start: false },
    )
    const container = new CaffeineIoC({ decorators: false })
    await using info = testClient(infoRouter(container, store), { container })
    await info.$ready()
    container.get(RunInfoContrib).push({ source: 'kafka', topics: 2 })

    const res = await info.info.get()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.application).toEqual({
      name: 'petstore',
      profiles: ['staging'],
      contrib: [{ source: 'kafka', topics: 2 }],
    })
    expect(body.runtime).toMatchObject({ node: process.version, pid: process.pid, nodeEnv: process.env.NODE_ENV })
    // Milliseconds: within a second of what the process reports, not a count of seconds.
    expect(Math.abs(body.runtime.uptime - process.uptime() * Second)).toBeLessThan(1 * Second)
    expect(Date.parse(body.runtime.startedAt)).toBeLessThan(Date.now())
    await store.close()
  })
})
