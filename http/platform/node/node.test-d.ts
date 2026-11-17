import type { ListenOptions } from 'node:net'

import type { FeatureConfigureKit } from '@caffeinejs/application'
import { expectTypeOf } from 'vitest'

import { createWebApplication as createFetchApplication, type WebRunInfo } from '../../application.js'
import { listenersOf, Router, type ContextPlatform, type NodeContextPlatform } from '../../index.js'
import type { NodeHTTPServer } from './connections.js'
import { createWebApplication, type NodeWebApplication } from './node.js'
import type { NodeServerSettings } from './settings.js'

/** What the Node application's server, `run()` and handlers are typed as, and what its settings refuse. */
const app = createWebApplication()

expectTypeOf(app.instance).toEqualTypeOf<NodeHTTPServer>()
expectTypeOf<Parameters<typeof app.run>[0]>().toEqualTypeOf<ListenOptions | undefined>()
expectTypeOf(app.run()).resolves.toEqualTypeOf<WebRunInfo>()

new Router('/x').get('/', ctx => {
  expectTypeOf(ctx.platform).toEqualTypeOf<ContextPlatform>()
  if (ctx.platform.name === 'node') {
    expectTypeOf(ctx.platform).toEqualTypeOf<NodeContextPlatform>()
  }
  expectTypeOf(ctx.req.raw).toEqualTypeOf<Request>()
  return 'ok'
})

// A listener hands over its Node server, and mounting a router keeps the Node application's type.
expectTypeOf(app.listeners.get('x')!.instance).toEqualTypeOf<NodeHTTPServer>()
expectTypeOf(app.mount(new Router('/y'))).toEqualTypeOf<NodeWebApplication<never, never, unknown>>()

// @ts-expect-error The fetch application has no server instance.
void createFetchApplication().instance

// @ts-expect-error Only the Node application hands over its server.
createFetchApplication().serverCallback(() => undefined)

// @ts-expect-error A plugin factory returns an HTTPPlugin.
app.with(() => ({}))

// @ts-expect-error A middleware runs at a request hook point.
app.use((_ctx, next) => next(), { hook: 'before' })

app.server(() => ({ listen: { port: 0 }, trustProxy: 'loopback', http2: true }))

// @ts-expect-error A hop count cannot tell a proxy from a client.
app.server(() => ({ trustProxy: 1 }))

// @ts-expect-error The fetch runtime gives no peer address, so the fetch application takes a boolean.
createFetchApplication().server(() => ({ trustProxy: 'loopback' }))

// A listener takes the application's settings: `listen` on the Node application, never on the fetch one.
app.listener('a', l => l.server(() => ({ listen: { port: 0 } })))

// @ts-expect-error The fetch application takes no listen section.
createFetchApplication().listener('a', l => l.server(() => ({ listen: { port: 0 } })))

// A feature names the settings it writes: a `listen` section only under NodeServerSettings.
declare const kit: FeatureConfigureKit

listenersOf<unknown, NodeServerSettings>(kit).add('m', l => l.server(() => ({ listen: { port: 0 } })))

// @ts-expect-error Without NodeServerSettings, a feature's listener takes no listen section.
listenersOf(kit).add('m', l => l.server(() => ({ listen: { port: 0 } })))
