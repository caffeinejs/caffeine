import type { WebApplication } from '@caffeinejs/http'
import { newConfiguration } from '@caffeinejs/std'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { $t } from '@caffeinejs/std/schema'
import { afterEach, describe, expect, it } from 'vitest'

import { info, type DevToolsInfoReport } from '../index.js'
import { get, target } from './fixtures.js'

describe('the info slice', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // The name is the framework's own block: it is reported whether or not the application's schema declares it.
  it('reports the application name, its profiles and the process it runs in', async () => {
    const conf = newConfiguration($t.Object({}))
      .source(new InlineConfigSource({ caffeine: { name: 'orders' } }))
      .build().config

    app = target({ config: conf, profiles: ['eu'], devtools: d => d.slices(info()) })
    await app.bootstrap()

    const report = (await (await get(app, '/devtools/info')).json()) as DevToolsInfoReport

    expect(report).toMatchObject({
      name: 'orders',
      node: process.version,
      platform: process.platform,
      pid: process.pid,
    })
    expect(report.profiles).toContain('eu')
    expect(report.uptime).toBeGreaterThan(0)
    expect(report.memory.heapUsed).toBeGreaterThan(0)
    expect(report.memory.rss).toBeGreaterThan(0)
  })
})
