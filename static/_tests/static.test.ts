import { fileURLToPath } from 'node:url'

import { token } from '@caffeinejs/di'
import { WebApplication, createWebApplication } from '@caffeinejs/http'
import { newConfiguration } from '@caffeinejs/std'
import type { InferConfig } from '@caffeinejs/std/config'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { $t } from '@caffeinejs/std/schema'
import { afterEach, describe, expect, it } from 'vitest'

import { staticFiles } from '../index.js'
import { StaticConfigSchema } from '../schema.js'

const fixtures = fileURLToPath(new URL('./_testdata/fixtures', import.meta.url))
const fixtures2 = fileURLToPath(new URL('./_testdata/fixtures2', import.meta.url))

describe('static feature', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('serves a file under the configured prefix', async () => {
    app = createWebApplication({}).with(staticFiles(s => s.serve(fixtures, { prefix: '/static' })))
    await app.bootstrap()

    const res = await app.fetch('/static/hello.txt')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(await res.text()).toContain('hello static world')
  })

  it('sets the css content-type from the extension', async () => {
    app = createWebApplication({}).with(staticFiles(s => s.serve(fixtures, { prefix: '/assets' })))
    await app.bootstrap()

    const res = await app.fetch('/assets/style.css')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/css/)
  })

  it('404s for a missing file', async () => {
    app = createWebApplication({}).with(staticFiles(s => s.serve(fixtures, { prefix: '/static' })))
    await app.bootstrap()

    const res = await app.fetch('/static/nope.txt')

    expect(res.status).toBe(404)
  })

  it('serves from multiple mounts (only the first decorates reply)', async () => {
    app = createWebApplication({}).with(
      staticFiles(s => s.serve(fixtures, { prefix: '/one' }).serve(fixtures2, { prefix: '/two' })),
    )
    await app.bootstrap()

    const one = await app.fetch('/one/hello.txt')
    const two = await app.fetch('/two/other.txt')

    expect(one.status).toBe(200)
    expect(await one.text()).toContain('hello static world')
    expect(two.status).toBe(200)
    expect(await two.text()).toContain('second mount file')
  })
})

// A deployment can point the mounts somewhere else without touching code, and a mount written in code stands.
describe('static feature under StaticConfigSchema', () => {
  const schema = $t.Object({ static: $t.Object(StaticConfigSchema.properties, { default: {} }) })
  const kConfig = token<InferConfig<typeof schema>>(Symbol('static.config.test'))
  type AppConfig = InferConfig<typeof schema>

  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  function configured(mounts: unknown[]) {
    return newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ static: { mounts } }))
      .build()
  }

  // `prefix` is not declared by the schema: it has to survive the configuration loading to reach the plugin.
  it('serves the configured mounts with the @fastify/static options they carry', async () => {
    app = createWebApplication({ config: configured([{ root: fixtures, prefix: '/from-config' }]) }).with(
      staticFiles<AppConfig>((s, { config }) => s.config(config.static)),
    )
    await app.bootstrap()

    const res = await app.fetch('/from-config/hello.txt')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('hello static world')
  })

  it('serves only the mounts written in code when there are any', async () => {
    app = createWebApplication({ config: configured([{ root: fixtures, prefix: '/from-config' }]) }).with(
      staticFiles<AppConfig>((s, { config }) => s.config(config.static).serve(fixtures2, { prefix: '/coded' })),
    )
    await app.bootstrap()

    expect((await app.fetch('/coded/other.txt')).status).toBe(200)
    expect((await app.fetch('/from-config/hello.txt')).status).toBe(404)
  })
})
