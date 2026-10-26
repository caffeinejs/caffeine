import { newConfiguration, RunInfoContrib } from '@caffeinejs/application'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { $t } from '@caffeinejs/application/schema'
import { CaffeineIoC } from '@caffeinejs/di'
import type { WebApplication } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { devTools } from '../devtools.js'
import type { InfoRecord } from './info.js'

/** What an operator asks first of a running process: which application, under which profiles, on what. */
describe('InfoTool', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('names the application, its profiles, what its features reported and the process it runs in', async () => {
    const conf = newConfiguration($t.Object({}))
      .source(new InlineConfigSource({ caffeine: { name: 'petstore' } }))
      .build().config
    app = createWebApplication({ container: new CaffeineIoC(), config: conf }).with(context => {
      context.container.get(RunInfoContrib).push({ source: 'kafka', topics: 2 })
      return devTools()(context)
    }) as WebApplication
    await app.bootstrap()

    const info = (await (await app.fetch('/devtools/info')).json()) as InfoRecord

    expect(info.application).toEqual({ name: 'petstore', profiles: [], contrib: [{ source: 'kafka', topics: 2 }] })
    expect(info.runtime).toMatchObject({ node: process.version, pid: process.pid, nodeEnv: process.env.NODE_ENV })
    expect(info.runtime.uptime).toBeGreaterThan(0)
    expect(Date.parse(info.runtime.startedAt)).toBeLessThan(Date.now())
  })
})
