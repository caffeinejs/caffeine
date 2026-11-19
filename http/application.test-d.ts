import type { RunInfo } from '@caffeinejs/application'
import { expectTypeOf } from 'vitest'

import { createWebApplication, type WebApplication } from './application.js'
import type { FetchAdapter } from './core/server/hosting.js'
import { Router, type ServerAddress } from './index.js'
import { bun } from './platform/bun/index.js'
import { node } from './platform/node.testkit.js'

/** What an application under no adapter is typed as: no server, no listen options. */
const app = createWebApplication()

expectTypeOf(app.instance).toEqualTypeOf<undefined>()
expectTypeOf(app.run()).resolves.toEqualTypeOf<RunInfo>()
expectTypeOf(app.mount(new Router('/y'))).toEqualTypeOf<WebApplication<never, never, unknown, FetchAdapter>>()

// Naming the configuration's type keeps the no-adapter types.
expectTypeOf(createWebApplication<{ a: 1 }>().instance).toEqualTypeOf<undefined>()

// @ts-expect-error No adapter, no socket: run() takes no listen options.
void app.run({ port: 0 })

// @ts-expect-error No adapter, no socket: the settings take no listen section.
app.server(() => ({ listen: { port: 0 } }))

// @ts-expect-error No adapter, no socket: a listener's settings take no listen section either.
app.listener('a', l => l.server(() => ({ listen: { port: 0 } })))

// @ts-expect-error The runtime gives no peer address, so trustProxy is a boolean.
app.server(() => ({ trustProxy: 'loopback' }))

// @ts-expect-error No adapter builds no server to hand over.
app.serverCallback(() => undefined)

// A bare WebApplication takes an application on any adapter.
const anyApp: WebApplication[] = [
  app,
  createWebApplication({ adapter: node() }),
  createWebApplication({ adapter: bun() }),
]
void anyApp

// A bare WebApplication does not know its adapter: its run() may resolve with where it listens, or not.
declare const bare: WebApplication
expectTypeOf(bare.run()).resolves.toEqualTypeOf<RunInfo & { readonly address?: ServerAddress }>()
