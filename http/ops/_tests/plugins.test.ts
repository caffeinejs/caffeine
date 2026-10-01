import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { type Context, Ops, bindTo, createWebApplication, newRouter, type WebApplication } from '../../index.js'

/**
 * An ops server's own plugins and middleware: registered on its builder, `o.with(...)`, `o.use(...)` and
 * `o.useFn(...)`, they run on that server alone, and nothing the application registers on its own server reaches it.
 */

const listener = { host: '127.0.0.1', port: 0 }

/** A plugin marking every response it covers with `header`. */
function marking(header: string, value = 'yes') {
  return () =>
    fp(
      async (instance: FastifyInstance) => {
        instance.addHook('onRequest', (_request, reply, done) => {
          const previous = reply.getHeader(header)
          reply.header(header, previous === undefined ? value : `${String(previous)},${value}`)
          done()
        })
      },
      { name: `marking:${header}:${value}` },
    )
}

/** A middleware marking every response it runs for with `header`. */
function tagging(header: string) {
  return (ctx: Context, next: () => void) => {
    ctx.header(header, 'yes')
    next()
  }
}

const jobs = () =>
  newRouter('/jobs')
    .with(bindTo('admin'))
    .get('/', () => ({ jobs: true }))

const status = () =>
  newRouter('/status')
    .with(bindTo('admin'))
    .get('/', () => ({ up: true }))

const api = () => newRouter('/api').get('/', () => ({ api: true }))

describe("an ops server's own plugins and middleware", () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  function at(server: 'main' | 'admin', path: string): Promise<Response> {
    const origin = server === 'main' ? app!.address!.origin : app!.ops.get('admin')!.address!.origin
    return fetch(`${origin}${path}`)
  }

  it("installs its own plugins in the order they were written, and none of the application's", async () => {
    app = createWebApplication()
      .install(
        Ops('admin', o =>
          o
            .server(() => ({ listener }))
            .with(marking('x-order', 'first'))
            .with(marking('x-order', 'second')),
        ),
      )
      .server(() => ({ listener }))
      .with(marking('x-app-plugin'))
      .mount(jobs(), api()) as WebApplication

    await app.run()

    const onOps = await at('admin', '/jobs')
    expect(onOps.headers.get('x-order')).toBe('first,second')
    expect(onOps.headers.get('x-app-plugin')).toBeNull()

    const onMain = await at('main', '/api')
    expect(onMain.headers.get('x-app-plugin')).toBe('yes')
    expect(onMain.headers.get('x-order')).toBeNull()
  })

  it("runs its own middleware on its own requests, by path, and the application's on the application's", async () => {
    app = createWebApplication()
      .install(
        Ops('admin', o =>
          o
            .server(() => ({ listener }))
            .use(tagging('x-ops-middleware'))
            .use('/jobs', tagging('x-jobs-middleware'))
            .useFn(() => tagging('x-built-middleware')),
        ),
      )
      .server(() => ({ listener }))
      .mount(jobs(), status(), api()) as WebApplication
    app.use(tagging('x-app-middleware'))

    await app.run()

    const onJobs = await at('admin', '/jobs')
    expect(onJobs.headers.get('x-ops-middleware')).toBe('yes')
    expect(onJobs.headers.get('x-jobs-middleware')).toBe('yes')
    expect(onJobs.headers.get('x-built-middleware')).toBe('yes')
    expect(onJobs.headers.get('x-app-middleware')).toBeNull()

    const onStatus = await at('admin', '/status')
    expect(onStatus.headers.get('x-ops-middleware')).toBe('yes')
    expect(onStatus.headers.get('x-jobs-middleware')).toBeNull()

    const onMain = await at('main', '/api')
    expect(onMain.headers.get('x-app-middleware')).toBe('yes')
    expect(onMain.headers.get('x-ops-middleware')).toBeNull()
    expect(onMain.headers.get('x-built-middleware')).toBeNull()
  })

  it('refuses a feature handed to its with(...), as the application refuses one', async () => {
    app = createWebApplication().install(Ops('admin', o => o.with(Ops('other') as never))) as WebApplication

    await expect(app.bootstrap()).rejects.toThrow(
      /^Cannot register feature "ops:other" with "\.with\(\.\.\.\)": a feature is not a server plugin/,
    )
  })
})
