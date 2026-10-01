import { token } from '@caffeinejs/di'
import { Controller, Get, createWebApplication } from '@caffeinejs/http'
import { newConfiguration } from '@caffeinejs/std'
import type { InferConfig } from '@caffeinejs/std/config'
import { EnvConfigSource } from '@caffeinejs/std/config/env'
import { $t } from '@caffeinejs/std/schema'
import { afterEach, describe, expect, it } from 'vitest'

import { HTTPCachingConfigSchema } from '../../schema.js'
import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { CacheControl, HTTPCaching } from '../index.js'
import { HTTPCachingOptionsBuilder, kBuild } from '../options_builder.js'

// What a fluent method sets is final, and `config(...)` fills in only what no method set.
describe('HTTPCachingOptionsBuilder.config', () => {
  it('fills in what no method set', () => {
    const options = new HTTPCachingOptionsBuilder()
      .config({ statusHeader: 'X-Configured', storeTimeout: 500, varyByQuery: ['page'] })
      .storeTimeout('1s')
      [kBuild]()

    expect(options.statusHeader).toBe('X-Configured')
    expect(options.storeTimeout).toBe('1s')
    expect(options.varyByQuery).toEqual(['page'])
  })
})

describe('HTTPCaching under HTTPCachingConfigSchema', () => {
  const schema = $t.Object({ cache: $t.Object(HTTPCachingConfigSchema.properties, { default: {} }) })
  const kConfig = token<InferConfig<typeof schema>>(Symbol('caching.config.test'))

  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('answers with the status header the environment names', async () => {
    @Controller('/caching-configured')
    class ConfiguredController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ConfiguredController]

    const conf = newConfiguration(schema, kConfig)
      .source(new EnvConfigSource({ env: { CACHE__STATUS_HEADER: 'X-From-Env' } }))
      .build()
    const app = createWebApplication({ config: conf }).with(
      HTTPCaching<InferConfig<typeof schema>>((b, { config }) =>
        b.config(config.cache).store(new MemoryHTTPCacheStore()),
      ),
    )
    close = () => app.close()
    await app.bootstrap()

    const res = await app.fetch('/caching-configured/data')

    expect(res.headers.get('x-from-env')).toBe('MISS')
  })
})
