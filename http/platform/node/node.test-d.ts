import type { ListenOptions } from 'node:net'

import type { FeatureConfigureKit } from '@caffeinejs/application'
import type { ConfigDefinition, ConfigSnapshot } from '@caffeinejs/application/config'
import { expectTypeOf } from 'vitest'

import {
  createWebApplication,
  type WebApplication,
  type WebApplicationOptions,
  type WebRunInfo,
} from '../../application.js'
import { listenersOf, Router, type ContextPlatform, type NodeContextPlatform } from '../../index.js'
import type { NodeHTTPServer } from './connections.js'
import { node, type NodeAdapter } from './node.js'
import type { NodeServerSettings } from './settings.js'

/** What an application under `node()` types its server, `run()` and handlers as, and what its settings refuse. */
const app = createWebApplication({ adapter: node() })

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

// A listener hands over its Node server, and mounting a router keeps the adapter in the application's type.
expectTypeOf(app.listeners.get('x')!.instance).toEqualTypeOf<NodeHTTPServer>()
expectTypeOf(app.mount(new Router('/y'))).toEqualTypeOf<WebApplication<never, never, unknown, NodeAdapter>>()

// The server callback gets the application's typed configuration and Node's server.
declare const config: ConfigDefinition<{ app: { headersTimeout: number } }>

createWebApplication({ adapter: node(), config }).serverCallback((context, server) => {
  expectTypeOf(context.config).toEqualTypeOf<ConfigSnapshot<{ app: { headersTimeout: number } }>>()
  expectTypeOf(server).toEqualTypeOf<NodeHTTPServer>()
})

// The TSDoc example: a member every Node server has.
app.serverCallback((_, server) => {
  server.setTimeout(1)
})

// @ts-expect-error A plugin factory returns an HTTPPlugin.
app.with(() => ({}))

// @ts-expect-error A middleware runs at a request hook point.
app.use((_ctx, next) => next(), { hook: 'before' })

app.server(() => ({ listen: { port: 0 }, trustProxy: 'loopback', http2: true }))

// @ts-expect-error A hop count cannot tell a proxy from a client.
app.server(() => ({ trustProxy: 1 }))

// A listener takes the adapter's settings: `listen` under `node()`.
app.listener('a', l => l.server(() => ({ listen: { port: 0 } })))

// Naming the configuration's type alone still takes the adapter, typed as any adapter; naming both keeps Node's types.
const named = createWebApplication<{ a: 1 }>({ adapter: node() })
expectTypeOf(named.instance).toEqualTypeOf<unknown>()
expectTypeOf(named).toEqualTypeOf<WebApplication<never, never, { a: 1 }>>()

const both = createWebApplication<{ a: 1 }, NodeAdapter>({ adapter: node() })
expectTypeOf(both.instance).toEqualTypeOf<NodeHTTPServer>()
both.server(() => ({ listen: { port: 0 }, http2: true }))

// Options typed beforehand with the adapter optional may hold none: they never promise Node's types.
declare const options: WebApplicationOptions<{ a: 1 }, NodeAdapter>
// @ts-expect-error The adapter may be missing, which would serve under no adapter at all.
void createWebApplication(options)
expectTypeOf(createWebApplication({ ...options, adapter: node() }).instance).toEqualTypeOf<NodeHTTPServer>()

// A feature names the settings it writes: a `listen` section only under NodeServerSettings.
declare const kit: FeatureConfigureKit

listenersOf<unknown, NodeServerSettings>(kit).add('m', l => l.server(() => ({ listen: { port: 0 } })))

// @ts-expect-error Without NodeServerSettings, a feature's listener takes no listen section.
listenersOf(kit).add('m', l => l.server(() => ({ listen: { port: 0 } })))
