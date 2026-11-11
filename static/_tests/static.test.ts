import { newConfiguration } from '@caffeinejs/application'
import type { InferConfig } from '@caffeinejs/application/config'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { $t } from '@caffeinejs/application/schema'
import { WebApplication } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, inject, it } from 'vitest'

import { staticFiles } from '../index.js'

const { fixtures, fixtures2 } = inject('fixtures')

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

    const res = await app.request('/static/hello.txt')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toContain('hello static world')
  })

  it('sets the css content-type from the extension', async () => {
    app = createWebApplication({}).with(staticFiles(s => s.serve(fixtures, { prefix: '/assets' })))
    await app.bootstrap()

    const res = await app.request('/assets/style.css')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8')
  })

  it('404s for a missing file', async () => {
    app = createWebApplication({}).with(staticFiles(s => s.serve(fixtures, { prefix: '/static' })))
    await app.bootstrap()

    const res = await app.request('/static/nope.txt')

    expect(res.status).toBe(404)
  })

  it('serves several mounts from one staticFiles(...)', async () => {
    app = createWebApplication({}).with(
      staticFiles(s => s.serve(fixtures, { prefix: '/one' }).serve(fixtures2, { prefix: '/two' })),
    )
    await app.bootstrap()

    const one = await app.request('/one/hello.txt')
    const two = await app.request('/two/other.txt')

    expect(one.status).toBe(200)
    expect(await one.text()).toContain('hello static world')
    expect(two.status).toBe(200)
    expect(await two.text()).toContain('second mount file')
  })
})

// A deployment can point the mounts somewhere else without touching code, and a mount written in code stands.
describe('static feature configured from the tree', () => {
  // The members a deployment sets, declared as an application declares them.
  const mount = $t.Object({
    root: $t.String(),
    prefix: $t.Optional($t.String()),
    immutable: $t.Optional($t.Array($t.String())),
    cacheControl: $t.Optional($t.String()),
  })
  const schema = $t.Object({ static: $t.Object({ mounts: $t.Optional($t.Array(mount)) }, { default: {} }) })
  type AppConfig = InferConfig<typeof schema>

  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  function configured(mounts: unknown[]) {
    return newConfiguration(schema)
      .source(new InlineConfigSource({ static: { mounts } }))
      .build().config
  }

  it('serves the configured mounts with the MountOptions members they carry', async () => {
    app = createWebApplication({
      config: configured([
        { root: fixtures, prefix: '/from-config', immutable: ['style.css'], cacheControl: 'max-age=60' },
      ]),
    }).with(staticFiles<AppConfig>((s, { config }) => s.config(config.static)))
    await app.bootstrap()

    const text = await app.request('/from-config/hello.txt')
    const css = await app.request('/from-config/style.css')

    expect(text.status).toBe(200)
    expect(await text.text()).toContain('hello static world')
    expect(text.headers.get('cache-control')).toBe('private, max-age=60')
    expect(css.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  })

  it('serves only the mounts written in code when there are any', async () => {
    app = createWebApplication({ config: configured([{ root: fixtures, prefix: '/from-config' }]) }).with(
      staticFiles<AppConfig>((s, { config }) => s.config(config.static).serve(fixtures2, { prefix: '/coded' })),
    )
    await app.bootstrap()

    expect((await app.request('/coded/other.txt')).status).toBe(200)
    expect((await app.request('/from-config/hello.txt')).status).toBe(404)
  })
})
