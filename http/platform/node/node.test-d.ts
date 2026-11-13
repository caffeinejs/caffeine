import type { ListenOptions } from 'node:net'

import { expectTypeOf } from 'vitest'

import { createWebApplication as createFetchApplication, type WebRunInfo } from '../../application.js'
import type { NodeHTTPServer } from './connections.js'
import { createWebApplication, newRouter } from './node.js'
import type { NodeContextPlatform } from './platform.js'

/** What the Node application's server, `run()` and handlers are typed as, and what its settings refuse. */
const app = createWebApplication()

expectTypeOf(app.instance).toEqualTypeOf<NodeHTTPServer>()
expectTypeOf<Parameters<typeof app.run>[0]>().toEqualTypeOf<ListenOptions | undefined>()
expectTypeOf(app.run()).resolves.toEqualTypeOf<WebRunInfo>()

newRouter('/x').get('/', ctx => {
  expectTypeOf(ctx.platform).toEqualTypeOf<NodeContextPlatform>()
  expectTypeOf(ctx.req.raw).toEqualTypeOf<Request>()
  return 'ok'
})

app.server(() => ({ listen: { port: 0 }, trustProxy: 'loopback', http2: true }))

// @ts-expect-error A hop count cannot tell a proxy from a client.
app.server(() => ({ trustProxy: 1 }))

// @ts-expect-error The fetch runtime gives no peer address, so the fetch application takes a boolean.
createFetchApplication().server(() => ({ trustProxy: 'loopback' }))
