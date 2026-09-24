import { Http2ServerRequest } from 'node:http2'
import { Server as HTTPSServer } from 'node:https'

import type { FastifyInstance } from 'fastify'
import { expectTypeOf } from 'vitest'

import { createWebApplication, type Context } from '../index.js'

/**
 * What `.server(...)` accepts for TLS and HTTP/2, and what the instance is typed as once it is built. The server
 * kind is picked by configuration at `ready()`, so the instance is one type whichever it is, and the TLS-only
 * surface is reached by narrowing. `npm run test:typecheck` is the test.
 */

const key = 'key'
const cert = 'cert'
const app = createWebApplication()

app.server(() => ({ factory: { https: { key, cert } } }))
app.server(() => ({ factory: { http2: true, https: { key, cert, allowHTTP1: true } } }))
app.server(() => ({ factory: { http2: true } }))
// Fastify reads `https: null` as plain HTTP, so a configuration that turns TLS off can say so.
app.server(() => ({ factory: { https: null } }))

// @ts-expect-error — a key is a string or a buffer, not a number.
app.server(() => ({ factory: { https: { key: 1, cert } } }))

// @ts-expect-error — `http2` is a switch.
app.server(() => ({ factory: { http2: 'yes' } }))

// @ts-expect-error — the settings have no such section.
app.server(() => ({ tls: { key, cert } }))

expectTypeOf(app.instance).toEqualTypeOf<FastifyInstance>()

// Rotating a certificate without a restart is the reason to reach the TLS server.
const server = app.instance.server
if (server instanceof HTTPSServer) {
  server.setSecureContext({ key, cert })
}

app.serverCallback((_context, instance) => {
  if (instance.server instanceof HTTPSServer) {
    instance.server.setSecureContext({ key, cert })
  }
})

// Under HTTP/2 the raw request is typed as its HTTP/1 counterpart; what only HTTP/2 has is one narrowing away.
declare const ctx: Context
if (ctx.req.raw instanceof Http2ServerRequest) {
  expectTypeOf(ctx.req.raw.stream.id).toEqualTypeOf<number | undefined>()
}
