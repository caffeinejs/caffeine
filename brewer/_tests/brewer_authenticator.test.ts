import { createHash } from 'node:crypto'

import { $t } from '@caffeinejs/application/schema'
import { Router, bodyAsBuffer } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  brewer,
  ErrBrewFollowUpNotSent,
  ErrBrewTooManyFollowUps,
  type Authenticator,
  type BrewClient,
  type BrewOptions,
  type Interceptor,
} from '../index.js'
import { Tokens } from './_tokens.js'

/**
 * Authentication as applications meet it, against a real server: an OAuth access token that expires, a refresh token
 * that rotates, many calls refused at once, Basic and Digest challenges, a rotated API key, redirects to other
 * origins, and callers that leave while a refresh is under way.
 *
 * Every route records what reached it, so each test asserts on the credentials the server saw.
 */

interface Hit {
  method: string
  path: string
  authorization: string | null
  key: string | null
  id: string | null
  tenant: string | null
  type: string | null
  size: number
  sha256: string | null
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

// What reached the server, request by request, in the order they arrived.
const hits: Hit[] = []

interface Exchange {
  readonly req: { readonly method: string; readonly url: string; header(name: string): string | undefined }
  status(code: number): unknown
  header(name: string, value: string): unknown
}

function hit(ctx: Exchange, bytes?: Uint8Array): void {
  hits.push({
    method: ctx.req.method,
    path: ctx.req.url.split('?')[0]!,
    authorization: ctx.req.header('authorization') ?? null,
    key: ctx.req.header('x-api-key') ?? null,
    id: ctx.req.header('x-request-id') ?? null,
    tenant: ctx.req.header('x-tenant') ?? null,
    type: ctx.req.header('content-type') ?? null,
    size: bytes?.byteLength ?? 0,
    sha256: bytes === undefined ? null : sha256(bytes),
  })
}

/** The authorization server's side: the access token it accepts, and the refresh token it takes, once. */
const server = {
  access: 'access-1',
  refresh: 'refresh-1',
  serial: 1,
  refreshes: 0,
  key: 'key-2',
  // Holds the token endpoint until the test opens it, and tells it when a refresh has arrived.
  gate: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
}

// A Digest-style challenge: the first answer meets a nonce gone stale, the second a fresh one.
const digest = { nonce: 'nonce-1', stale: true }

const allowed = (ctx: Exchange) => ctx.req.header('authorization') === `Bearer ${server.access}`

function refuse(ctx: Exchange, challenge = 'Bearer error="invalid_token"', error = 'invalid_token') {
  ctx.status(401)
  ctx.header('www-authenticate', challenge)
  return { error }
}

// Holds a request in its handler until the test lets it go.
let latch: { started: () => void; held: Promise<void> } | undefined

function hold(): { started: Promise<void>; release: () => void } {
  const started = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  latch = { started: started.resolve, held: held.promise }

  return { started: started.promise, release: held.resolve }
}

// The body a streaming 401 answers with, written by the test, which is told when the client cancels it.
let feeding: ReadableStream<Uint8Array> | undefined

function feed(): { write(text: string): void; readonly cancelled: Promise<void> } {
  const cancelled = Promise.withResolvers<void>()
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  feeding = new ReadableStream<Uint8Array>({
    start: c => {
      controller = c
    },
    cancel: () => cancelled.resolve(),
  })

  return { write: text => controller.enqueue(encoder.encode(text)), cancelled: cancelled.promise }
}

let otherOrigin: string

const secure = new Router('/secure')
  .get('/pets')
  .handler(ctx => {
    hit(ctx)
    return allowed(ctx) ? { pets: ['Rex', 'Tom'] } : refuse(ctx)
  })
  .post('/pets')
  .extend(bodyAsBuffer())
  .handler(ctx => {
    hit(ctx, ctx.req.body() as Uint8Array)
    return allowed(ctx) ? { saved: true } : refuse(ctx)
  })
  .query('/search')
  .extend(bodyAsBuffer())
  .handler(ctx => {
    hit(ctx, ctx.req.body() as Uint8Array)
    return allowed(ctx) ? { found: ['Rex'] } : refuse(ctx)
  })
  .get('/slow')
  .handler(async ctx => {
    hit(ctx)
    latch?.started()
    await latch?.held
    return allowed(ctx) ? { slow: true } : refuse(ctx)
  })
  .get('/held')
  .handler(async ctx => {
    hit(ctx)
    if (!allowed(ctx)) {
      return refuse(ctx)
    }
    latch?.started()
    await latch?.held
    return { held: true }
  })
  .get('/status/:code')
  .schema({ params: $t.Object({ code: $t.Integer() }) })
  .handler(ctx => {
    hit(ctx)
    ctx.status(ctx.req.param().code)
    return { code: ctx.req.param().code }
  })
  .get('/scope')
  .handler(ctx => {
    hit(ctx)
    return refuse(ctx, 'Bearer error="insufficient_scope", scope="admin"', 'insufficient_scope')
  })
  .get('/bare')
  .handler(ctx => {
    hit(ctx)
    if (!allowed(ctx)) {
      ctx.status(401)
      return undefined
    }
    return { bare: true }
  })
  .delete('/pets')
  .handler(ctx => {
    hit(ctx)
    if (!allowed(ctx)) {
      return refuse(ctx)
    }
    ctx.status(204)
    return undefined
  })
  // HEAD on a path no GET answers: a GET's own HEAD twin would collide with it.
  .head('/peek')
  .handler(ctx => {
    hit(ctx)
    if (allowed(ctx)) {
      ctx.header('x-found', 'yes')
    } else {
      refuse(ctx)
    }
  })
  .get('/challenge')
  .handler(ctx => {
    hit(ctx)
    if (allowed(ctx)) {
      return Response.json({ ok: true })
    }
    return new Response(feeding, {
      status: 401,
      headers: { 'www-authenticate': 'Bearer error="invalid_token"', 'content-type': 'application/json' },
    })
  })

const schemes = new Router('/schemes')
  .get('/basic')
  .handler(ctx => {
    hit(ctx)
    const expected = `Basic ${Buffer.from('admin:s3cret').toString('base64')}`
    return ctx.req.header('authorization') === expected ? { admin: true } : refuse(ctx, 'Basic realm="admin"', 'denied')
  })
  .get('/digest')
  .handler(ctx => {
    hit(ctx)
    const header = ctx.req.header('authorization') ?? ''
    const nonce = /nonce="([^"]+)"/.exec(header)?.[1]
    const answer = /response="([^"]+)"/.exec(header)?.[1]
    if (nonce === digest.nonce && answer === sha256(`${nonce}:vault-password`)) {
      if (!digest.stale) {
        return { opened: true }
      }
      digest.stale = false
      digest.nonce = 'nonce-2'
      return refuse(ctx, `Digest realm="vault", nonce="${digest.nonce}", stale=true`, 'stale')
    }
    return refuse(ctx, `Digest realm="vault", nonce="${digest.nonce}"`, 'challenge')
  })
  .get('/report')
  .handler(ctx => {
    hit(ctx)
    if (ctx.req.header('x-api-key') !== server.key) {
      return refuse(ctx, 'ApiKey realm="reports"', 'invalid_key')
    }
    return { report: 'Q3', language: ctx.req.header('accept-language') ?? null }
  })

const redirects = new Router('/redirect')
  .get('/here')
  .handler(ctx => ctx.redirect('/secure/pets'))
  .get('/away')
  .handler(ctx => ctx.redirect(`${otherOrigin}/cdn/blob`))
  .get('/out')
  .handler(ctx => {
    hit(ctx)
    return allowed(ctx) ? ctx.redirect(`${otherOrigin}/cdn/echo`) : refuse(ctx)
  })

// The token endpoint: each refresh token is good for one refresh, which issues the next pair.
const oauth = new Router('/oauth')
  .post('/token')
  .schema({ body: $t.Object({ grant_type: $t.String(), refresh_token: $t.String() }) })
  .handler(async ctx => {
    server.entered?.()
    await server.gate
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

const cdn = new Router('/cdn')
  .get('/blob')
  .handler(ctx => {
    hit(ctx)
    return refuse(ctx, 'Bearer realm="cdn"', 'cdn_token_required')
  })
  .get('/echo')
  .handler(ctx => {
    hit(ctx)
    return { authorization: ctx.req.header('authorization') ?? null }
  })

// An abort can leave the client a connection it opened and never finished a request on, which the server's graceful
// close would otherwise wait out: a connection quiet for a second is dropped instead.
const app = createWebApplication()
  .server(() => ({ factory: { connectionTimeout: 1000 } }))
  .mount(secure, schemes, redirects, oauth)

const other = createWebApplication()
  .server(() => ({ factory: { connectionTimeout: 1000 } }))
  .mount(cdn)

let origin: string

beforeAll(async () => {
  await app.run()
  await other.run()
  origin = app.address!.origin
  otherOrigin = other.address!.origin
})

afterAll(async () => {
  await app.close()
  await other.close()
})

beforeEach(() => {
  hits.length = 0
  Object.assign(server, {
    access: 'access-1',
    refresh: 'refresh-1',
    serial: 1,
    refreshes: 0,
    key: 'key-2',
    gate: undefined,
    entered: undefined,
  })
  Object.assign(digest, { nonce: 'nonce-1', stale: true })
})

class ErrSessionExpired extends Error {
  constructor(reason: string) {
    super(`The session expired: ${reason}`)
    this.name = 'ErrSessionExpired'
  }
}

type Connect = (options?: BrewOptions) => BrewClient<typeof app>

/**
 * The application's token store: it starts with an access token the server no longer takes, and refreshes it at the
 * token endpoint through a client of its own, never through one it authenticates.
 */
function tokensFor(connect: Connect): Tokens {
  let refreshToken = 'refresh-1'
  const authorizationServer = connect()

  return new Tokens('access-0', async () => {
    const res = await authorizationServer.oauth.token.post({
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    })
    const grant = (await res.json()) as { access_token: string; refresh_token: string } | { error: string }
    if ('error' in grant) {
      throw new ErrSessionExpired(grant.error)
    }
    refreshToken = grant.refresh_token
    return grant.access_token
  })
}

/** An authenticator that counts the 401s it is asked about, and the attempt each was. */
function counting(authenticator: Authenticator): { authenticator: Authenticator; attempts: number[] } {
  const attempts: number[] = []

  return {
    attempts,
    authenticator: (request, response, attempt) => {
      attempts.push(attempt)
      return authenticator(request, response, attempt)
    },
  }
}

const transports = [
  ['in process', ((options?: BrewOptions) => brewer(app, options)) as Connect],
  ['over a socket', ((options?: BrewOptions) => brewer<typeof app>(origin, options)) as Connect],
] as const

describe.each(transports)('brewer answering a 401, %s', (_transport, connect) => {
  describe('given an OAuth access token that has expired', () => {
    // The caller asked for pets, not for a token dance: the refresh happens once, out of its sight.
    it('should refresh it once, send the call again with the new token, and resolve with that answer', async () => {
      const tokens = tokensFor(connect)
      const client = connect({ headers: tokens.headers, authenticator: tokens.authenticator })

      const res = await client.secure.pets.get()

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ pets: ['Rex', 'Tom'] })
      expect(server.refreshes).toBe(1)
      expect(hits.map(entry => entry.authorization)).toEqual(['Bearer access-0', 'Bearer access-2'])
    })

    // A token endpoint that rotates its refresh token takes each one once: a second refresh would log the user out.
    it('should refresh once for 10 calls across two clients refused at once', async () => {
      const gate = Promise.withResolvers<void>()
      server.gate = gate.promise
      const tokens = tokensFor(connect)
      let asked = 0
      const everyone = Promise.withResolvers<void>()
      const authenticator: Authenticator = (request, response, attempt) => {
        if (++asked === 10) {
          everyone.resolve()
        }
        return tokens.authenticator(request, response, attempt)
      }
      const pets = connect({ headers: tokens.headers, authenticator })
      const search = connect({ headers: tokens.headers, authenticator })

      const calls = Array.from({ length: 10 }, (_, n) =>
        n % 2 === 0 ? pets.secure.pets.get() : search.secure.search.query({ body: { name: 'Rex' } }),
      )
      await everyone.promise
      gate.resolve()
      const responses = await Promise.all(calls)

      expect(responses.map(res => res.status)).toEqual(Array.from({ length: 10 }, () => 200))
      expect(server.refreshes).toBe(1)
    })

    // A call held by the server while another refreshed comes back refused for the old token: it needs the new one,
    // not a second refresh, which the rotated refresh token would refuse.
    it('should send a call refused for a token already replaced again, without refreshing again', async () => {
      const tokens = tokensFor(connect)
      const client = connect({ headers: tokens.headers, authenticator: tokens.authenticator })
      const { started, release } = hold()

      const slow = client.secure.slow.get()
      await started
      expect((await client.secure.pets.get()).status).toBe(200)
      release()

      expect((await slow).status).toBe(200)
      expect(server.refreshes).toBe(1)
      expect(hits.filter(entry => entry.path === '/secure/slow').map(entry => entry.authorization)).toEqual([
        'Bearer access-0',
        'Bearer access-2',
      ])
    })

    // A call made while the refresh is under way still carries the old token, and joins the refresh in flight.
    it('should answer a call made while a refresh is under way with that same refresh', async () => {
      const gate = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      server.gate = gate.promise
      server.entered = entered.resolve
      const tokens = tokensFor(connect)
      const second = Promise.withResolvers<void>()
      let asked = 0
      const client = connect({
        headers: tokens.headers,
        authenticator: (request, response, attempt) => {
          if (++asked === 2) {
            second.resolve()
          }
          return tokens.authenticator(request, response, attempt)
        },
      })

      const first = client.secure.pets.get()
      await entered.promise
      const later = client.secure.pets.get()
      await second.promise
      gate.resolve()

      expect((await first).status).toBe(200)
      expect((await later).status).toBe(200)
      expect(server.refreshes).toBe(1)
    })
  })

  describe('given a refresh token the server revoked', () => {
    // A session that cannot be renewed is the application's to end: every call waiting on it learns why.
    it('should reject every waiting call with the error the authenticator throws', async () => {
      server.refresh = 'refresh-revoked'
      const tokens = tokensFor(connect)
      const client = connect({ headers: tokens.headers, authenticator: tokens.authenticator })

      const results = await Promise.allSettled([client.secure.pets.get(), client.secure.pets.get()])

      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
      for (const result of results) {
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ErrSessionExpired)
      }
    })

    // Giving up hands the caller the server's own answer, body and all, to show a sign-in page with.
    it('should resolve with the 401, its body whole, when the authenticator reads it and gives up', async () => {
      server.refresh = 'refresh-revoked'
      const tokens = tokensFor(connect)
      const read: unknown[] = []
      const client = connect({
        headers: tokens.headers,
        authenticator: async (request, response, attempt) => {
          read.push(await response.json())
          try {
            return await tokens.authenticator(request, response, attempt)
          } catch {
            return null
          }
        },
      })

      const res = await client.secure.pets.get()

      expect(res.status).toBe(401)
      expect(read).toEqual([{ error: 'invalid_token' }])
      expect(await res.json()).toEqual({ error: 'invalid_token' })
    })
  })

  describe('given a 401 for a scope the token lacks', () => {
    // Refreshing cannot add a scope: the authenticator reads the challenge and leaves the refusal to the caller.
    it('should resolve with the 401 without a refresh', async () => {
      const tokens = tokensFor(connect)
      const client = connect({
        headers: tokens.headers,
        authenticator: (request, response, attempt) =>
          response.headers.get('www-authenticate')?.includes('insufficient_scope')
            ? null
            : tokens.authenticator(request, response, attempt),
      })

      const res = await client.secure.scope.get()

      expect(res.status).toBe(401)
      expect(server.refreshes).toBe(0)
    })
  })

  describe('given a Basic challenge', () => {
    const basic =
      (password: string): Authenticator =>
      (request, _response, attempt) => {
        if (attempt > 1) {
          return null
        }
        request.headers.set('authorization', `Basic ${btoa(`admin:${password}`)}`)
        return request
      }

    // The challenge names the scheme; the follow-up answers it.
    it('should answer it and resolve with the follow-up', async () => {
      const { authenticator, attempts } = counting(basic('s3cret'))
      const client = connect({ authenticator })

      const res = await client.schemes.basic.get()

      expect(await res.json()).toEqual({ admin: true })
      expect(attempts).toEqual([1])
    })

    // A wrong password is refused again: giving up on the second 401 stops there instead of trying forever.
    it('should resolve with the second 401 when the password is wrong, after two sends', async () => {
      const { authenticator, attempts } = counting(basic('wrong'))
      const client = connect({ authenticator })

      const res = await client.schemes.basic.get()

      expect(res.status).toBe(401)
      expect(attempts).toEqual([1, 2])
      expect(hits).toHaveLength(2)
    })
  })

  describe('given a Digest-style challenge whose nonce goes stale', () => {
    // A stale nonce is a second challenge, not a refusal: the scheme needs a second round, within the default limit.
    it('should answer both rounds and resolve with the third answer', async () => {
      const { authenticator, attempts } = counting((request, response) => {
        const nonce = /nonce="([^"]+)"/.exec(response.headers.get('www-authenticate') ?? '')![1]!
        request.headers.set('authorization', `Digest nonce="${nonce}", response="${sha256(`${nonce}:vault-password`)}"`)
        return request
      })
      const client = connect({ authenticator })

      const res = await client.schemes.digest.get()

      expect(await res.json()).toEqual({ opened: true })
      expect(attempts).toEqual([1, 2])
      expect(hits).toHaveLength(3)
    })
  })

  describe('given an API key the server rotated', () => {
    // Credentials live in any header: the key is replaced, and every other header the call sent stays.
    it('should replace the key and keep every other header of the call', async () => {
      const client = connect({
        headers: { 'x-api-key': 'key-1', 'x-tenant': 'acme' },
        authenticator: (request, _response, attempt) => {
          request.headers.set('x-api-key', 'key-2')
          return attempt === 1 ? request : null
        },
      })

      const res = await client.schemes.report.get({ headers: { 'accept-language': 'pt-BR' } })

      expect(await res.json()).toEqual({ report: 'Q3', language: 'pt-BR' })
      expect(hits.map(entry => [entry.key, entry.tenant])).toEqual([
        ['key-1', 'acme'],
        ['key-2', 'acme'],
      ])
    })
  })

  describe('given a 401 an interceptor answers itself', () => {
    // Signing in lazily: no token yet means no request worth sending, and the authenticator is where one is found.
    it("should answer it like the server's, the follow-up passing the interceptor with the new token", async () => {
      let token: string | undefined
      const needsToken: Interceptor = async (request, next) => {
        if (token === undefined) {
          return new Response(null, { status: 401 })
        }
        request.headers.set('authorization', `Bearer ${token}`)
        return next(request)
      }
      const client = connect({
        interceptors: [needsToken],
        authenticator: (request, _response, attempt) => {
          token = server.access
          return attempt === 1 ? request : null
        },
      })

      const res = await client.secure.pets.get()

      expect(res.status).toBe(200)
      expect(hits.map(entry => entry.authorization)).toEqual(['Bearer access-1'])
    })
  })

  describe('given a status other than 401', () => {
    // A 403 refuses credentials the server accepted, and a 500 is no challenge: neither is the authenticator's.
    it.each([403, 500])('should resolve a %i without asking', async code => {
      const { authenticator, attempts } = counting(() => null)
      const client = connect({ authenticator })

      const res = await client.secure.status({ code }).get()

      expect(res.status).toBe(code)
      expect(attempts).toEqual([])
    })
  })

  describe('given what the authenticator is handed', () => {
    // It decides from what was refused: the credential the call sent, its own headers, its URL, its body.
    it('should hand it the request as the client built it and the 401 as the server sent it', async () => {
      let handed: { request: Record<string, unknown>; response: Record<string, unknown> } | undefined
      let resolved = 0
      const client = connect({
        headers: () => {
          resolved++
          return { authorization: 'Bearer access-0' }
        },
        interceptors: [
          async (request, next) => {
            request.headers.set('x-request-id', 'set-by-an-interceptor')
            return next(request)
          },
        ],
        authenticator: async (request, response, attempt) => {
          handed = {
            request: {
              method: request.method,
              url: request.url,
              authorization: request.headers.get('authorization'),
              tenant: request.headers.get('x-tenant'),
              id: request.headers.get('x-request-id'),
              body: await request.clone().text(),
            },
            response: {
              status: response.status,
              challenge: response.headers.get('www-authenticate'),
              body: await response.json(),
            },
          }
          request.headers.set('authorization', `Bearer ${server.access}`)
          return attempt === 1 ? request : null
        },
      })

      const res = await client.secure.search.query({
        body: { name: 'Rex' },
        query: { page: 2 },
        headers: { 'x-tenant': 'acme' },
      })

      expect(res.status).toBe(200)
      expect(handed).toEqual({
        request: {
          method: 'QUERY',
          url: expect.stringMatching(/\/secure\/search\?page=2$/),
          authorization: 'Bearer access-0',
          tenant: 'acme',
          id: null,
          body: '{"name":"Rex"}',
        },
        response: { status: 401, challenge: 'Bearer error="invalid_token"', body: { error: 'invalid_token' } },
      })
      // Resolved once for the call: the follow-up carries what the authenticator set, not a second reading.
      expect(resolved).toBe(1)
      expect(hits.map(entry => entry.sha256)).toEqual([sha256('{"name":"Rex"}'), sha256('{"name":"Rex"}')])
    })

    // A 401 can come with no body and no challenge at all; it is still the authenticator's to answer.
    it('should ask about a 401 with no body and no challenge', async () => {
      const { authenticator, attempts } = counting((request, _response, attempt) => {
        request.headers.set('authorization', `Bearer ${server.access}`)
        return attempt === 1 ? request : null
      })
      const client = connect({ authenticator })

      const res = await client.secure.bare.get()

      expect(await res.json()).toEqual({ bare: true })
      expect(attempts).toEqual([1])
    })

    // An interceptor that logs bodies reads the 401 before the authenticator: the authenticator is asked all the same.
    it('should ask about a 401 whose body an interceptor already read', async () => {
      const tokens = tokensFor(connect)
      const client = connect({
        headers: tokens.headers,
        interceptors: [
          async (request, next) => {
            const response = await next(request)
            await response.text()
            return response
          },
        ],
        authenticator: tokens.authenticator,
      })

      const res = await client.secure.pets.get()

      expect(res.status).toBe(200)
    })

    // HEAD and a 204 carry no body either way: the follow-up keeps the method and resolves as the server answered.
    it('should keep a HEAD a HEAD, and resolve a follow-up answered 204 with no body', async () => {
      const client = connect({
        headers: { authorization: 'Bearer expired' },
        authenticator: (request, _response, attempt) => {
          request.headers.set('authorization', `Bearer ${server.access}`)
          return attempt === 1 ? request : null
        },
      })

      const head = await client.secure.peek.head()
      const deleted = await client.secure.pets.delete()

      expect(head.headers.get('x-found')).toBe('yes')
      expect(deleted.status).toBe(204)
      expect(deleted.body).toBeNull()
      expect(hits.map(entry => entry.method)).toEqual(['HEAD', 'HEAD', 'DELETE', 'DELETE'])
    })
  })

  describe("given the 401's body", () => {
    // An unread body holds its connection until it is read or cancelled: the follow-up must not leave that to the
    // garbage collector, so the authenticator here keeps the 401 it is handed, as a logger might.
    it('should cancel the 401 and the copy the authenticator was handed before the follow-up leaves', async () => {
      let kept: Response | undefined
      let first: Response | undefined
      const atFollowUp: boolean[] = []
      const client = connect({
        headers: { authorization: 'Bearer expired' },
        interceptors: [
          async (request, next) => {
            if (first !== undefined) {
              atFollowUp.push(first.bodyUsed, kept!.bodyUsed)
            }
            const response = await next(request)
            first ??= response
            return response
          },
        ],
        authenticator: (request, response, attempt) => {
          kept = response
          request.headers.set('authorization', `Bearer ${server.access}`)
          return attempt === 1 ? request : null
        },
      })

      const res = await client.secure.pets.get()

      expect(res.status).toBe(200)
      expect(atFollowUp).toEqual([true, true])
    })

    // The authenticator's copy shares the 401's body: left open, it would keep the caller's own cancel from ever
    // reaching the server.
    it('should let the caller release a 401 given up on, while the authenticator keeps its copy', async () => {
      let kept: Response | undefined
      const client = connect({
        authenticator: (_request, response) => {
          kept = response
          return null
        },
      })

      const res = await client.secure.pets.get()
      await res.body!.cancel()

      expect(res.status).toBe(401)
      expect(kept!.bodyUsed).toBe(true)
    })
  })

  describe('given 401 after 401', () => {
    const neverRight: Authenticator = request => {
      request.headers.set('authorization', 'Bearer still-wrong')
      return request
    }

    // An authenticator that never gives up must not hammer the server: the limit stops it, loudly.
    it('should send 3 follow-ups, then reject with ErrBrewTooManyFollowUps without asking again', async () => {
      const { authenticator, attempts } = counting(neverRight)
      const client = connect({ authenticator })

      const failure = await client.secure.pets.get({ query: { api_key: 's3cret' } }).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(ErrBrewTooManyFollowUps)
      expect(failure).toMatchObject({ code: 'ERR_BREW_TOO_MANY_FOLLOW_UPS', name: 'ErrBrewTooManyFollowUps' })
      expect((failure as Error).message).toMatch(/^Cannot answer the 401 to "GET http:\/\/[^"]+\/secure\/pets": /)
      expect((failure as Error).message).not.toContain('s3cret')
      expect(attempts).toEqual([1, 2, 3])
      expect(hits).toHaveLength(4)
    })

    // The limit is the application's: a scheme with more rounds raises it, a strict client lowers it.
    it.each([1, 5])('should send at most %i follow-ups when maxFollowUps says so', async limit => {
      const { authenticator, attempts } = counting(neverRight)
      const client = connect({ authenticator, maxFollowUps: limit })

      await expect(client.secure.pets.get()).rejects.toBeInstanceOf(ErrBrewTooManyFollowUps)
      expect(attempts).toEqual(Array.from({ length: limit }, (_, i) => i + 1))
      expect(hits).toHaveLength(limit + 1)
    })

    // 0 follow-ups is a client that may not answer any 401, and says so at the first.
    it('should reject the first 401 without asking when maxFollowUps is 0', async () => {
      const { authenticator, attempts } = counting(neverRight)
      const client = connect({ authenticator, maxFollowUps: 0 })

      await expect(client.secure.pets.get()).rejects.toThrow(/already sent 0 follow-ups, and maxFollowUps allows 0/)
      expect(attempts).toEqual([])
      expect(hits).toHaveLength(1)
    })

    // A limit read from the environment can come out as NaN: it must fail loudly, never loop.
    it('should reject rather than loop when maxFollowUps is NaN', async () => {
      const { authenticator, attempts } = counting(neverRight)
      const client = connect({ authenticator, maxFollowUps: Number('three') })

      await expect(client.secure.pets.get()).rejects.toThrow(/maxFollowUps is NaN, and only a finite number/)
      expect(attempts).toEqual([])
    })

    // No limit is no cap on a server that refuses every credential: an authenticator that never gives up would loop.
    it('should reject rather than loop when maxFollowUps is Infinity', async () => {
      const { authenticator, attempts } = counting(neverRight)
      const client = connect({ authenticator, maxFollowUps: Number.POSITIVE_INFINITY })

      const failure = await client.secure.pets.get().catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(ErrBrewTooManyFollowUps)
      expect((failure as Error).message).toMatch(/maxFollowUps is Infinity, and only a finite number/)
      expect(attempts).toEqual([])
      expect(hits).toHaveLength(1)
    })
  })

  describe('given an authenticator that fails', () => {
    // Its error explains the failure better than the 401 would, and nothing more is sent.
    it.each([
      [
        'throws',
        (() => {
          throw new Error('the vault is sealed')
        }) as Authenticator,
      ],
      ['rejects', (async () => Promise.reject(new Error('the vault is sealed'))) as Authenticator],
    ])('should reject with its error when it %s', async (_how, failing) => {
      const client = connect({ authenticator: failing })

      await expect(client.secure.pets.get()).rejects.toThrow('the vault is sealed')
      expect(hits).toHaveLength(1)
    })
  })

  describe('given a follow-up the client cannot send', () => {
    // A challenge comes from the server, and an authenticator that follows a URL from it could hand credentials to
    // anyone: the follow-up stays with the call's origin.
    it('should refuse one to another origin, send nothing there, and keep the query out of the message', async () => {
      const client = connect({
        authenticator: request => {
          const elsewhere = new Request(`${otherOrigin}/cdn/echo?token=leaked`, request)
          elsewhere.headers.set('authorization', 'Bearer access-1')
          return elsewhere
        },
      })

      const failure = await client.secure.pets.get({ query: { api_key: 's3cret' } }).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(ErrBrewFollowUpNotSent)
      expect((failure as Error).message).toMatch(/it does not target "http:\/\/[^"]+"/)
      expect((failure as Error).message).not.toMatch(/s3cret|leaked/)
      expect(hits.filter(entry => entry.path.startsWith('/cdn'))).toEqual([])
    })

    // A follow-up whose body the authenticator read could only go out empty: the platform refuses it instead.
    it('should reject a follow-up whose body the authenticator read, sending nothing empty', async () => {
      const client = connect({
        authenticator: async request => {
          await request.text()
          request.headers.set('authorization', `Bearer ${server.access}`)
          return request
        },
      })

      await expect(client.secure.pets.post({ body: { name: 'Rex' } })).rejects.toThrow(TypeError)
      expect(hits).toHaveLength(1)
      expect(hits[0]!.size).toBe('{"name":"Rex"}'.length)
    })
  })

  describe('given interceptors', () => {
    // The follow-up is a request of its own: what interceptors compute per request is computed again for it.
    it('should send the follow-up through every interceptor again, each exchange its own', async () => {
      const tokens = tokensFor(connect)
      const statuses: number[] = []
      let serial = 0
      const client = connect({
        headers: tokens.headers,
        authenticator: tokens.authenticator,
        interceptors: [
          async (request, next) => {
            request.headers.set('x-request-id', `req-${++serial}`)
            const response = await next(request)
            statuses.push(response.status)
            return response
          },
        ],
      })

      await client.secure.pets.get()

      expect(statuses).toEqual([401, 200])
      expect(hits.map(entry => entry.id)).toEqual(['req-1', 'req-2'])
    })

    // A failure on the follow-up is the call's failure, as it is: a retry around the call can recognise it.
    it('should reject with the error the follow-up fails with', async () => {
      const tokens = tokensFor(connect)
      let sends = 0
      const client = connect({
        headers: tokens.headers,
        authenticator: tokens.authenticator,
        interceptors: [
          async (request, next) => {
            if (++sends === 2) {
              throw new TypeError('the connection was reset')
            }
            return next(request)
          },
        ],
      })

      await expect(client.secure.pets.get()).rejects.toThrow('the connection was reset')
    })
  })

  describe('given a call aborted before its 401 is answered', () => {
    // A caller that left needs no refresh made on its behalf.
    it('should reject with the reason, never asking', async () => {
      const controller = new AbortController()
      const { authenticator, attempts } = counting(() => null)
      const client = connect({
        authenticator,
        interceptors: [
          async (request, next) => {
            const response = await next(request)
            controller.abort(new Error('the user left the page'))
            return response
          },
        ],
      })

      await expect(client.secure.pets.get({ signal: controller.signal })).rejects.toThrow('the user left the page')
      expect(attempts).toEqual([])
    })
  })

  describe('given a caller that leaves while the refresh it waits on is under way', () => {
    // A refresh can be slow, or hang on its token endpoint: the caller that left must be let go at once, and the
    // others still served by the one refresh.
    it('should reject that call at once, serve the others, and never send its follow-up', async () => {
      const gate = Promise.withResolvers<void>()
      server.gate = gate.promise
      const tokens = tokensFor(connect)
      const both = Promise.withResolvers<void>()
      let asked = 0
      const client = connect({
        headers: tokens.headers,
        authenticator: (request, response, attempt) => {
          if (++asked === 2) {
            both.resolve()
          }
          return tokens.authenticator(request, response, attempt)
        },
      })
      const controller = new AbortController()

      const leaving = client.secure.pets.get({ signal: controller.signal })
      const staying = client.secure.pets.get()
      await both.promise
      controller.abort(new Error('the user left the page'))

      // Rejected while the refresh is still held at the token endpoint.
      await expect(leaving).rejects.toThrow('the user left the page')
      gate.resolve()
      expect((await staying).status).toBe(200)
      expect(server.refreshes).toBe(1)
      expect(hits.filter(entry => entry.path === '/secure/pets')).toHaveLength(3)
    })

    // A client-wide signal, such as one shut down with the application, lets go of a call in any step.
    it('should reject a call of a client whose own signal aborts', async () => {
      const gate = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      server.gate = gate.promise
      server.entered = entered.resolve
      const tokens = tokensFor(connect)
      const controller = new AbortController()
      const client = connect({
        headers: tokens.headers,
        authenticator: tokens.authenticator,
        signal: controller.signal,
      })

      try {
        const call = client.secure.pets.get()
        await entered.promise
        controller.abort(new Error('the application is shutting down'))

        await expect(call).rejects.toThrow('the application is shutting down')
      } finally {
        gate.resolve()
      }
    })
  })

  describe("given the call's RequestInit fields", () => {
    // The follow-up is the same call again: how it caches, sends credentials and follows redirects is the call's.
    it('should send the follow-up under the same fields as the first request', async () => {
      const tokens = tokensFor(connect)
      const sent: Array<Record<string, unknown>> = []
      const client = connect({
        headers: tokens.headers,
        authenticator: tokens.authenticator,
        cache: 'no-store',
        credentials: 'include',
        keepalive: true,
        interceptors: [
          async (request, next) => {
            sent.push({
              cache: request.cache,
              credentials: request.credentials,
              keepalive: request.keepalive,
              redirect: request.redirect,
            })
            return next(request)
          },
        ],
      })

      await client.secure.pets.get({ redirect: 'manual' })

      expect(sent).toHaveLength(2)
      expect(sent[1]).toEqual(sent[0])
      expect(sent[0]).toEqual({ cache: 'no-store', credentials: 'include', keepalive: true, redirect: 'manual' })
    })
  })
})

describe('brewer answering a 407', () => {
  // A 407 is a proxy's challenge, answered where the proxy is configured: never the authenticator's.
  it('should resolve it in process without asking', async () => {
    const { authenticator, attempts } = counting(() => null)

    const res = await brewer(app, { authenticator }).secure.status({ code: 407 }).get()

    expect(res.status).toBe(407)
    expect(attempts).toEqual([])
  })

  // Outside a browser, fetch reports a 407 as a network error, as the fetch standard has it for a request with no
  // window: the call rejects, and the authenticator is still not asked.
  it('should reject over a socket as fetch does, without asking', async () => {
    const { authenticator, attempts } = counting(() => null)

    await expect(brewer<typeof app>(origin, { authenticator }).secure.status({ code: 407 }).get()).rejects.toThrow(
      TypeError,
    )
    expect(attempts).toEqual([])
  })
})

describe('brewer answering a 401 over a socket', () => {
  const connect: Connect = options => brewer<typeof app>(origin, options)

  describe('given redirects', () => {
    // Another origin's 401 is that server's challenge, and fetch dropped the credential on the way there: refreshing
    // the call's token would only loop.
    it("should resolve with another origin's 401 without asking, that origin never seeing the credential", async () => {
      const tokens = tokensFor(connect)
      const { authenticator, attempts } = counting(tokens.authenticator)
      const client = connect({ headers: tokens.headers, authenticator })

      const res = await client.redirect.away.get()

      expect(res.status).toBe(401)
      expect(res.url.startsWith(otherOrigin)).toBe(true)
      expect(attempts).toEqual([])
      expect(hits).toEqual([expect.objectContaining({ path: '/cdn/blob', authorization: null })])
    })

    // An interceptor that logs the body reads the 401 and hands on a copy: the copy is still the other origin's.
    it("should resolve with another origin's 401 without asking when an interceptor hands on a copy", async () => {
      const tokens = tokensFor(connect)
      const { authenticator, attempts } = counting(tokens.authenticator)
      const logged: string[] = []
      const logging: Interceptor = async (request, next) => {
        const response = await next(request)
        const copy = response.clone()
        logged.push(await response.text())
        return copy
      }
      const client = connect({ headers: tokens.headers, authenticator, interceptors: [logging] })

      const res = await client.redirect.away.get()

      expect(res.status).toBe(401)
      expect(res.url.startsWith(otherOrigin)).toBe(true)
      expect(attempts).toEqual([])
      expect(server.refreshes).toBe(0)
      expect(logged).toHaveLength(1)
      expect(await res.text()).toBe(logged[0])
    })

    // The call's own server challenged at the end of a redirect: the follow-up goes to the call's URL and follows it
    // again.
    it('should answer a 401 met at the end of a same-origin redirect, following it again', async () => {
      const tokens = tokensFor(connect)
      const client = connect({ headers: tokens.headers, authenticator: tokens.authenticator })

      const res = await client.redirect.here.get()

      expect(res.status).toBe(200)
      expect(server.refreshes).toBe(1)
    })

    // Credentials the authenticator sets belong to the call's origin: a redirect onwards must not carry them.
    it('should not let the credential the authenticator set follow a redirect to another origin', async () => {
      const tokens = tokensFor(connect)
      const client = connect({ headers: tokens.headers, authenticator: tokens.authenticator })

      const res = await client.redirect.out.get()

      expect(await res.json()).toEqual({ authorization: null })
      expect(hits.map(entry => [entry.path, entry.authorization])).toEqual([
        ['/redirect/out', 'Bearer access-0'],
        ['/redirect/out', 'Bearer access-2'],
        ['/cdn/echo', null],
      ])
    })
  })

  describe('given a 401 whose body is still streaming', () => {
    async function challenged(
      authenticator: Authenticator,
    ): Promise<{ call: Promise<Response>; body: ReturnType<typeof feed> }> {
      const body = feed()
      body.write('{"error":')
      const call = connect({ headers: { authorization: 'Bearer access-0' }, authenticator }).secure.challenge.get()

      return { call, body }
    }

    const answered: Authenticator = request => {
      request.headers.set('authorization', `Bearer ${server.access}`)
      return request
    }

    // An unread 401 holds its connection: it is cancelled before the follow-up leaves.
    it('should cancel the 401 before sending the follow-up', async () => {
      const { call, body } = await challenged(answered)

      await body.cancelled
      expect((await call).status).toBe(200)
    })

    // Reading a single chunk marks a body used without freeing it: what the authenticator left is cancelled too.
    it('should cancel what the authenticator left of a 401 it read in part', async () => {
      const { call, body } = await challenged(async (request, response) => {
        const reader = response.body!.getReader()
        await reader.read()
        reader.releaseLock()
        return answered(request, response, 1)
      })

      await body.cancelled
      expect((await call).status).toBe(200)
    })

    it.each([
      [
        'throws',
        (() => {
          throw new Error('the vault is sealed')
        }) as Authenticator,
      ],
      ['returns a request for another origin', (() => new Request(`${otherOrigin}/cdn/echo`)) as Authenticator],
    ])('should cancel the 401 when the authenticator %s', async (_how, authenticator) => {
      const { call, body } = await challenged(authenticator)

      await expect(call).rejects.toThrow()
      await body.cancelled
    })

    // Giving up hands the 401 to the caller, who may let it go unread: that must reach the server too.
    it('should let the caller release a 401 the authenticator gave up on', async () => {
      const { call, body } = await challenged(() => null)

      const res = await call
      expect(res.status).toBe(401)
      await res.body!.cancel()

      await body.cancelled
    })
  })

  describe('given a follow-up the server holds', () => {
    // The follow-up is built from the call's request, so it carries the call's signal: an abort reaches it in flight.
    it('should abort it in flight when the call aborts', async () => {
      const tokens = tokensFor(connect)
      const client = connect({ headers: tokens.headers, authenticator: tokens.authenticator })
      const controller = new AbortController()
      const { started, release } = hold()

      try {
        const call = client.secure.held.get({ signal: controller.signal })
        await started
        controller.abort()

        await expect(call).rejects.toMatchObject({ name: 'AbortError' })
      } finally {
        release()
      }
    })
  })

  describe('given a token endpoint that cannot be reached', () => {
    // An outage of the authorization server fails the calls waiting on it, and the next call tries again.
    it('should reject the waiting calls with the failure, and refresh again on the next call', async () => {
      const gone = createWebApplication().mount(oauth)
      await gone.run()
      const closed = gone.address!.origin
      await gone.close()
      let endpoint = closed
      let refreshToken = 'refresh-1'
      const tokens = new Tokens('access-0', async () => {
        const res = await brewer<typeof app>(endpoint).oauth.token.post({
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
        })
        const grant = (await res.json()) as { access_token: string; refresh_token: string }
        refreshToken = grant.refresh_token
        return grant.access_token
      })
      const client = connect({ headers: tokens.headers, authenticator: tokens.authenticator })

      await expect(client.secure.pets.get()).rejects.toThrow(TypeError)
      endpoint = origin
      const res = await client.secure.pets.get()

      expect(res.status).toBe(200)
      expect(server.refreshes).toBe(1)
    })
  })
})
