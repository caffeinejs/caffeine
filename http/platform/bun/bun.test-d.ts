import { expectTypeOf } from 'vitest'

import { createWebApplication, type WebRunInfo } from '../../application.js'
import { bun } from './bun.js'
import type { BunServer } from './runtime.js'
import type { BunListen } from './settings.js'

/** What an application under `bun()` types its server, `run()` and settings as. */
const app = createWebApplication({ adapter: bun() })

expectTypeOf(app.instance).toEqualTypeOf<BunServer | undefined>()
expectTypeOf<Parameters<typeof app.run>[0]>().toEqualTypeOf<BunListen | undefined>()
expectTypeOf(app.run({ port: 0 })).resolves.toEqualTypeOf<WebRunInfo>()
expectTypeOf(app.listeners.get('x')!.instance).toEqualTypeOf<BunServer | undefined>()

app.server(() => ({ listen: { host: '127.0.0.1', port: 0 }, https: { key: '', cert: '' }, trustProxy: 'loopback' }))

app.serverCallback((_, server) => {
  expectTypeOf(server).toEqualTypeOf<BunServer>()
})

// @ts-expect-error HTTP/2 is node:http2's, which Bun does not serve.
app.server(() => ({ http2: true }))

// @ts-expect-error Bun listens with node:net's names: `host`, never `hostname`.
app.server(() => ({ listen: { hostname: '127.0.0.1' } }))
