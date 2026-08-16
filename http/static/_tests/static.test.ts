import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import fastify from 'fastify'
import { CaffeineIoC } from '@caffeinejs/di'
import { StaticBuilder, WebApplication, createWebApplication, fastifyAdapterFactory, kStaticMounts } from '../../index.js'
import { Feats } from '../../feats.js'
import { kServiceConfigure } from '../../service.js'

const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url))
const fixtures2 = fileURLToPath(new URL('./fixtures2', import.meta.url))

describe('static feature', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('serves a file under the configured prefix', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .static(s => s.serve(fixtures, { prefix: '/static' }))
      .build()
    await app.ready()

    const res = await app.fetch('/static/hello.txt')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(await res.text()).toContain('hello static world')
  })

  it('sets the css content-type from the extension', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .static(s => s.serve(fixtures, { prefix: '/assets' }))
      .build()
    await app.ready()

    const res = await app.fetch('/assets/style.css')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/css/)
  })

  it('404s for a missing file', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .static(s => s.serve(fixtures, { prefix: '/static' }))
      .build()
    await app.ready()

    const res = await app.fetch('/static/nope.txt')

    expect(res.status).toBe(404)
  })

  it('serves from multiple mounts (only the first decorates reply)', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .static(s => s
        .serve(fixtures, { prefix: '/one' })
        .serve(fixtures2, { prefix: '/two' }))
      .build()
    await app.ready()

    const one = await app.fetch('/one/hello.txt')
    const two = await app.fetch('/two/other.txt')

    expect(one.status).toBe(200)
    expect(await one.text()).toContain('hello static world')
    expect(two.status).toBe(200)
    expect(await two.text()).toContain('second mount file')
  })
})

describe('StaticBuilder', () => {
  it('binds the mounts array to kStaticMounts', async () => {
    const container = new CaffeineIoC()
    const builder = new StaticBuilder()
    builder.serve(fixtures, { prefix: '/static' }).serve(fixtures2, { prefix: '/two' })

    await builder[kServiceConfigure]({ container, feats: new Feats() })
    await container.init()

    const mounts = container.get<Array<{ root: string, prefix?: string }>>(kStaticMounts)
    expect(mounts).toHaveLength(2)
    expect(mounts[0]).toEqual({ root: fixtures, prefix: '/static' })
    expect(mounts[1]).toEqual({ root: fixtures2, prefix: '/two' })
  })
})
