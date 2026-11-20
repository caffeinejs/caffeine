import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication, type WebApplication } from '../../application.js'
import { HTTPPlugin, type HTTPSetupContext } from '../../plugin.js'
import { Router } from '../routing/programmatic/programmatic.js'

let app: WebApplication<any, any, any> | undefined
const trace: string[] = []

afterEach(async () => {
  await app?.close()
  app = undefined
  trace.length = 0
})

function plugin(fn: (context: HTTPSetupContext) => void): () => HTTPPlugin {
  return () =>
    new (class extends HTTPPlugin {
      register(context: HTTPSetupContext): void {
        fn(context)
      }
    })()
}

function step(name: string) {
  return (): void => void trace.push(name)
}

describe('composeRouteHooks', () => {
  // Each level puts its plugins' hooks ahead of its middleware: the gate a plugin installs runs before `app.use(...)`.
  it("runs a level's middleware after its plugins' hooks", async () => {
    const a = createWebApplication()
      .use((_ctx, next) => {
        trace.push('middleware')
        next()
      })
      .with(plugin(({ app: ops }) => ops.hook('onRequest', step('plugin'))))
      .mount(new Router('/x').get('/').handler(() => 'x'))
    app = a
    await a.bootstrap()

    await a.request('/x')

    expect(trace).toEqual(['plugin', 'middleware'])
  })

  // A miss has no route: only the server's own hooks run, ahead of the not-found answer.
  it('runs the root hooks alone on a miss', async () => {
    const a = createWebApplication()
      .hook('onRequest', step('root'))
      .mount(
        new Router('/x')
          .hook('onRequest', step('router'))
          .get('/')
          .handler(() => 'x'),
      )
    app = a
    await a.bootstrap()

    const res = await a.request('/nowhere')

    expect(res.status).toBe(404)
    expect(trace).toEqual(['root'])
  })

  // One router nested under two parents is one scope at two paths: its relative middleware starts from each.
  it("runs a router plugin's path-scoped middleware under every parent", async () => {
    const shared = new Router('/r')
      .with(
        plugin(({ app: ops }) =>
          ops.use('/jobs', (ctx, next) => {
            trace.push(ctx.req.url)
            next()
          }),
        ),
      )
      .get('/jobs')
      .handler(() => 'jobs')

    const a = createWebApplication().mount(new Router('/a').mount(shared), new Router('/b').mount(shared))
    app = a
    await a.bootstrap()

    await a.request('/a/r/jobs')
    await a.request('/b/r/jobs')

    // Once per request under each parent, reading the request's whole URL.
    expect(trace).toEqual(['/a/r/jobs', '/b/r/jobs'])
  })
})
