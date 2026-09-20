import fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWebApplication, fastifyAdapterFactory, newRouter, type Context } from '../../../index.js'
import { ErrOAuthCallback } from '../internal/remote/errors.js'
import { ErrOIDCDiscovery } from './errors.js'

/**
 * What a client is told when a sign-in cannot go ahead. The errors of these strategies carry two messages: one
 * for the log, naming issuers, endpoints and what a fetch ran into, and one for the client. Routers only, no
 * controller: a controller registers into a process-global registry.
 */

const SESSION_SECRET = 'oidc-failure-responses-secret-32ch!!'
const ISSUER = 'https://idp.internal.example.com'
const UNREACHABLE = 'connect ECONNREFUSED 10.0.0.7:443'

interface LogEntry {
  level?: number
  msg?: string
  err?: { code?: string }
}

function application(onFail?: (ctx: Context, error: Error) => void, logged: LogEntry[] = []) {
  const server = fastify({
    logger: { level: 'warn', stream: { write: (line: string) => void logged.push(JSON.parse(line) as LogEntry) } },
  })

  return createWebApplication(fastifyAdapterFactory(server))
    .authentication(auth =>
      auth.addOIDC('Provider', o => {
        o.clientID('client')
          .clientSecret('client-secret')
          .sessionSecret(SESSION_SECRET)
          .callbackURL('https://app.example.com/oidc/callback')
          .discoveryURL(ISSUER)
          .issuer(ISSUER)

        if (onFail !== undefined) {
          o.onFail(onFail)
        }
      }),
    )
    .mount(
      newRouter().mount(
        newRouter('/account')
          .authorize({})
          .get('/', () => ({ ok: true })),
        newRouter('/sign-out').get('/', () => {
          throw new ErrOIDCDiscovery(`Cannot fetch OIDC discovery document: "${ISSUER}": ${UNREACHABLE}`)
        }),
      ),
    )
}

describe('a sign-in that cannot go ahead', () => {
  afterEach(() => vi.unstubAllGlobals())

  // Anyone can ask for a protected URL, so anyone would otherwise read where this deployment's provider lives
  // and what the network said when it was asked.
  it('tells an anonymous caller that the provider is unavailable, and nothing about it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(UNREACHABLE)))

    const app = application()
    await app.ready()

    const res = await app.fetch('/account', { headers: { 'sec-fetch-mode': 'navigate' } })
    const text = await res.text()

    expect(res.status).toBe(502)
    expect(JSON.parse(text)).toEqual({
      statusCode: 502,
      error: 'Bad Gateway',
      code: 'ERR_OIDC_DISCOVERY',
      message: 'Authentication provider is unavailable',
    })
    expect(text).not.toContain('10.0.0.7')
    expect(text).not.toContain('idp.internal')

    await app.close()
  })

  it('answers the same way when a route handler is where it surfaced', async () => {
    const app = application()
    await app.ready()

    const res = await app.fetch('/sign-out')
    const text = await res.text()

    expect(res.status).toBe(502)
    expect(JSON.parse(text)).toMatchObject({ statusCode: 502, message: 'Authentication provider is unavailable' })
    expect(text).not.toContain('10.0.0.7')
    expect(text).not.toContain('idp.internal')

    await app.close()
  })

  // The same rule for a failure that is the caller's doing: the public message goes out and the detail does not.
  // The log has it, as information: a request somebody got wrong is not a fault for an operator to be paged about.
  it('keeps the detail of a 4xx from the client as well, and logs it as information, not as an error', async () => {
    const logged: LogEntry[] = []
    const server = fastify({
      logger: { level: 'warn', stream: { write: (line: string) => void logged.push(JSON.parse(line) as LogEntry) } },
    })
    const app = createWebApplication(fastifyAdapterFactory(server)).mount(
      newRouter('/finish').get('/', () => {
        throw new ErrOAuthCallback('state mismatch for subject jane@example.com')
      }),
    )
    await app.ready()

    const res = await app.fetch('/finish')
    const text = await res.text()

    expect(res.status).toBe(400)
    expect(JSON.parse(text)).toMatchObject({ code: 'ERR_OAUTH_CALLBACK', message: 'Authentication failed' })
    expect(text).not.toContain('jane')

    // On record for whoever looks, at the level of a request and not of a fault (pino: 30 is info, 50 is error).
    const entries = logged.filter(entry => entry.err?.code === 'ERR_OAUTH_CALLBACK')
    expect(entries.map(entry => entry.level)).toEqual([30])
    expect(entries[0].msg).toContain('jane@example.com')

    await app.close()
  })

  it('still describes an ordinary error the ordinary way', async () => {
    const server = fastify({ logger: false })
    const app = createWebApplication(fastifyAdapterFactory(server)).mount(
      newRouter('/broken').get('/', () => {
        throw Object.assign(new Error('teapot'), { statusCode: 418 })
      }),
    )
    await app.ready()

    const res = await app.fetch('/broken')

    expect(res.status).toBe(418)
    expect(await res.json()).toMatchObject({ message: 'teapot' })

    await app.close()
  })
})

describe('a callback that fails', () => {
  // The provider sent the user back with a refusal. Raw JSON is no page to land a person on, so an application
  // sends them somewhere that says what happened, and that answer has to be the one that goes out.
  it('leaves the response to onFail when onFail answered', async () => {
    const seen: Error[] = []
    const logged: LogEntry[] = []
    const app = application((ctx, error) => {
      seen.push(error)
      ctx.redirect('/sign-in?failed=1', 303)
    }, logged)
    await app.ready()

    const res = await app.fetch('/oidc/callback?error=access_denied&state=abc')

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/sign-in?failed=1')
    expect(await res.text()).toBe('')
    expect(seen).toHaveLength(1)
    expect(seen[0].message).toContain('provider returned "access_denied"')

    // Nothing tried to answer a second time, and the failure itself is still on record.
    expect(logged.filter(entry => entry.err?.code === 'FST_ERR_REP_ALREADY_SENT')).toEqual([])
    expect(logged.some(entry => entry.msg === 'OIDC callback failed')).toBe(true)

    await app.close()
  })

  // The way `onChallenge` and `onForbid` are written: set the redirect, and leave the sending to the framework.
  it('sends the redirect onFail set up and left unsent', async () => {
    const app = application(ctx => void ctx.status(302).header('location', '/sign-in?failed=1'))
    await app.ready()

    const res = await app.fetch('/oidc/callback?error=access_denied&state=abc')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/sign-in?failed=1')
    expect(await res.text()).toBe('')

    await app.close()
  })

  // The hook is the application's code and may fail for reasons of its own. What it threw is not one of this
  // strategy's errors, so it has no public message to fall back on, and the client is told no more than ever.
  it('answers the same generic 400 when onFail itself throws, and says nothing of why', async () => {
    const app = application(() => {
      throw new Error('audit log at 10.0.0.9:5432 refused the write')
    })
    await app.ready()

    const res = await app.fetch('/oidc/callback?error=access_denied&state=abc')
    const text = await res.text()

    expect(res.status).toBe(400)
    expect(JSON.parse(text)).toEqual({ error: 'Authentication failed', statusCode: 400 })
    expect(text).not.toContain('10.0.0.9')

    await app.close()
  })

  it('answers a generic 400 when onFail only took note', async () => {
    const onFail = vi.fn()
    const app = application(onFail)
    await app.ready()

    const res = await app.fetch('/oidc/callback?error=access_denied&error_description=jane%40example.com&state=abc')
    const text = await res.text()

    expect(res.status).toBe(400)
    expect(JSON.parse(text)).toEqual({ error: 'Authentication failed', statusCode: 400 })
    expect(text).not.toContain('jane')
    expect(onFail).toHaveBeenCalledOnce()

    await app.close()
  })
})
