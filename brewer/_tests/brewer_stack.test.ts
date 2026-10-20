import { createHash, createHmac } from 'node:crypto'

import { $t } from '@caffeinejs/application/schema'
import { Router, bodyAsBuffer } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { brewer, type BrewClient, type BrewOptions } from '../index.js'
import { logging, retry, signing, tracing } from './_interceptors.js'
import { Tokens } from './_tokens.js'

/**
 * A client as a production application builds one: requests traced, retried on a transient failure, logged without
 * secrets and signed, under an OAuth token that expires, against a server that fails once and then refuses the token.
 *
 * The server records every request that reached it, so the test asserts on what went over the wire.
 */

const SIGNING_KEY = 'the shared signing key'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

interface Seen {
  id: string | null
  status: number
  signed: boolean
  sha256: string
}

// What reached the order route, request by request.
const seen: Seen[] = []

// The statuses the order route answers with, in turn, before it looks at the token.
let script: number[] = []

const server = { access: 'access-1', refresh: 'refresh-1', serial: 1, refreshes: 0 }

const orders = new Router('/orders')
  .post('/')
  .extend(bodyAsBuffer())
  .handler(ctx => {
    const bytes = ctx.req.body() as Uint8Array
    const signature = createHmac('sha256', SIGNING_KEY)
      .update(`${ctx.req.method}\n${ctx.req.url}\n${sha256(bytes)}`)
      .digest('hex')
    const status = script.shift() ?? (ctx.req.header('authorization') === `Bearer ${server.access}` ? 201 : 401)
    seen.push({
      id: ctx.req.header('x-request-id') ?? null,
      status,
      signed: ctx.req.header('x-signature') === signature,
      sha256: sha256(bytes),
    })
    ctx.status(status)
    if (status === 401) {
      ctx.header('www-authenticate', 'Bearer error="invalid_token"')
    }
    return status === 201
      ? { order: 'ord-1', items: (JSON.parse(new TextDecoder().decode(bytes)) as { items: string[] }).items }
      : { error: status === 401 ? 'invalid_token' : 'unavailable' }
  })

const oauth = new Router('/oauth')
  .post('/token')
  .schema({ body: $t.Object({ grant_type: $t.String(), refresh_token: $t.String() }) })
  .handler(ctx => {
    if (ctx.req.body().refresh_token !== server.refresh) {
      ctx.status(400)
      return { error: 'invalid_grant' }
    }
    server.serial++
    server.refreshes++
    server.access = `access-${server.serial}`
    server.refresh = `refresh-${server.serial}`
    return { access_token: server.access, refresh_token: server.refresh }
  })

const app = createWebApplication()
  .server(() => ({ factory: { connectionTimeout: 1000 } }))
  .mount(orders, oauth)

let origin: string

beforeAll(async () => {
  await app.run()
  origin = app.address!.origin
})

afterAll(async () => {
  await app.close()
})

beforeEach(() => {
  seen.length = 0
  script = []
  Object.assign(server, { access: 'access-1', refresh: 'refresh-1', serial: 1, refreshes: 0 })
})

type Connect = (options?: BrewOptions) => BrewClient<typeof app>

const transports = [
  ['in process', ((options?: BrewOptions) => brewer(app, options)) as Connect],
  ['over a socket', ((options?: BrewOptions) => brewer<typeof app>(origin, options)) as Connect],
] as const

describe.each(transports)('brewer with a production stack, %s', (_transport, connect) => {
  // Every piece in its place: the retry absorbs the transient failure inside the chain, the authenticator answers the
  // expired token around it, and every request that reaches the wire is traced, signed and logged without a secret.
  it('should place an order through a 503 and an expired token as one call', async () => {
    script = [503]
    const lines: string[] = []
    let traces = 0
    let refreshToken = 'refresh-1'
    const authorizationServer = connect()
    const tokens = new Tokens('access-0', async () => {
      const res = await authorizationServer.oauth.token.post({
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      })
      const grant = (await res.json()) as { access_token: string; refresh_token: string }
      refreshToken = grant.refresh_token
      return grant.access_token
    })
    const client = connect({
      headers: tokens.headers,
      authenticator: tokens.authenticator,
      interceptors: [tracing(() => `trace-${++traces}`), retry({ attempts: 3 }), logging(lines), signing(SIGNING_KEY)],
    })

    const res = await client.orders.post({ body: { items: ['espresso', 'croissant'] }, query: { source: 'web' } })

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ order: 'ord-1', items: ['espresso', 'croissant'] })
    expect(server.refreshes).toBe(1)
    // The retry stays inside one exchange and its trace; the follow-up is an exchange, and a trace, of its own.
    expect(seen.map(entry => [entry.id, entry.status, entry.signed])).toEqual([
      ['trace-1', 503, true],
      ['trace-1', 401, true],
      ['trace-2', 201, true],
    ])
    expect(new Set(seen.map(entry => entry.sha256)).size).toBe(1)
    expect(lines.filter(line => line.startsWith('<--'))).toEqual([
      expect.stringMatching(/^<-- 503 \/orders /),
      expect.stringMatching(/^<-- 401 \/orders /),
      expect.stringMatching(/^<-- 201 \/orders /),
    ])
    expect(lines.join('\n')).not.toMatch(/access-\d|source=web/)
  })
})
