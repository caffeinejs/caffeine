import { setTimeout as sleep } from 'node:timers/promises'

import { newNoopLogger, type LogFn, type Logger } from '@caffeinejs/application/logger'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWebApplication } from '../../../../application.js'
import { type IContext, Authentication, Router } from '../../../../index.js'
import { node } from '../../../../platform/node.testkit.js'
import { HTTPPlugin, type HTTPSetupContext } from '../../../../plugin.js'
import { authentication } from '../../security.js'
import { ErrOAuthCallback } from '../internal/remote/errors.js'
import { ErrOIDCDiscovery } from './errors.js'

// What the framework adds to every problem it sends. The values are pinned where they are what a test is about.
const STAMPED = { correlation_id: expect.stringMatching(/^req-/), timestamp: expect.any(String) }

/**
 * What a client is told when a sign-in cannot go ahead. The errors of these strategies carry two messages: one
 * for the log, naming issuers, endpoints and what a fetch ran into, and one for the client. Routers only, no
 * controller: a controller registers into a process-global registry.
 */

const SESSION_SECRET = 'oidc-failure-responses-secret-32ch!!'
const ISSUER = 'https://idp.internal.example.com'
const UNREACHABLE = 'connect ECONNREFUSED 10.0.0.7:443'

interface LogEntry {
  level: number
  msg: string
  err?: { code?: string }
  [field: string]: unknown
}

const LEVELS = { info: 30, warn: 40, error: 50 } as const

/** The application logger, recording each line at `threshold` or above into `logged`. */
function recordTo(logged: LogEntry[], threshold: keyof typeof LEVELS = 'warn'): Logger {
  const at = (level: keyof typeof LEVELS): LogFn =>
    ((obj: unknown, msg?: string) => {
      if (LEVELS[level] < LEVELS[threshold]) {
        return
      }
      const [fields, text] = typeof obj === 'string' ? [{}, obj] : [obj as Record<string, unknown>, msg ?? '']
      logged.push({ ...fields, level: LEVELS[level], msg: text })
    }) as LogFn
  const logger: Logger = {
    ...newNoopLogger(),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  }
  return logger
}

/** The engine's two warnings for an answer that came after the request was answered. */
const ALREADY_ANSWERED = [
  'Cannot answer a request already answered: dropping the late answer',
  'Cannot change the response once it is sent: ignoring',
]

/** An `onSend` hook that awaits, counting its runs. */
class SlowSend extends HTTPPlugin {
  override readonly name = 'slow-send'

  constructor(private readonly runs: { n: number }) {
    super()
  }

  register({ server }: HTTPSetupContext): void {
    server.hook('onSend', async (_ctx, payload) => {
      this.runs.n++
      await sleep(20)
      return payload
    })
  }
}

function application(onFail?: (ctx: IContext, error: Error) => void, logged: LogEntry[] = []) {
  return createWebApplication({ adapter: node() })
    .logger(b => b.use(recordTo(logged)))
    .install(
      Authentication(auth =>
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
      ),
    )
    .with(authentication())
    .mount(
      new Router().mount(
        new Router('/account').authorize().get('/', () => ({ ok: true })),
        new Router('/sign-out').get('/', () => {
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
    await app.bootstrap()

    const res = await app.request('/account', { headers: { 'sec-fetch-mode': 'navigate' } })
    const text = await res.text()

    expect(res.status).toBe(502)
    expect(JSON.parse(text)).toEqual({
      type: 'about:blank',
      title: 'Bad Gateway',
      status: 502,
      detail: 'Authentication provider is unavailable',
      code: 'ERR_OIDC_DISCOVERY',
      ...STAMPED,
    })
    expect(text).not.toContain('10.0.0.7')
    expect(text).not.toContain('idp.internal')

    await app.close()
  })

  it('answers the same way when a route handler is where it surfaced', async () => {
    const app = application()
    await app.bootstrap()

    const res = await app.request('/sign-out')
    const text = await res.text()

    expect(res.status).toBe(502)
    expect(JSON.parse(text)).toMatchObject({ status: 502, detail: 'Authentication provider is unavailable' })
    expect(text).not.toContain('10.0.0.7')
    expect(text).not.toContain('idp.internal')

    await app.close()
  })

  // The same rule for a failure that is the caller's doing: the public message goes out and the detail does not.
  // The log has it, as information: a request somebody got wrong is not a fault for an operator to be paged about.
  it('keeps the detail of a 4xx from the client as well, and logs it as information, not as an error', async () => {
    const logged: LogEntry[] = []
    const app = createWebApplication({ adapter: node() })
      // At `info`, since that is the level the record is expected at.
      .logger(b => b.use(recordTo(logged, 'info')))
      .mount(
        new Router('/finish').get('/', () => {
          throw new ErrOAuthCallback('state mismatch for subject jane@example.com')
        }),
      )
    await app.bootstrap()

    const res = await app.request('/finish')
    const text = await res.text()

    expect(res.status).toBe(400)
    expect(JSON.parse(text)).toMatchObject({ code: 'ERR_OAUTH_CALLBACK', detail: 'Authentication failed' })
    expect(text).not.toContain('jane')

    // On record for whoever looks, at the level of a request and not of a fault (30 is info, 50 is error).
    const entries = logged.filter(entry => entry.err?.code === 'ERR_OAUTH_CALLBACK')
    expect(entries.map(entry => entry.level)).toEqual([30])
    expect(entries[0].msg).toContain('jane@example.com')

    await app.close()
  })

  it('still describes an ordinary error the ordinary way', async () => {
    const app = createWebApplication({ adapter: node() }).mount(
      new Router('/broken').get('/', () => {
        throw Object.assign(new Error('teapot'), { statusCode: 418 })
      }),
    )
    await app.bootstrap()

    const res = await app.request('/broken')

    expect(res.status).toBe(418)
    expect(await res.json()).toMatchObject({ detail: 'teapot' })

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
    await app.bootstrap()

    const res = await app.request('/oidc/callback?error=access_denied&state=abc')

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/sign-in?failed=1')
    expect(await res.text()).toBe('')
    expect(seen).toHaveLength(1)
    expect(seen[0].message).toContain('provider returned "access_denied"')

    // Nothing tried to answer a second time, and the failure itself is still on record.
    expect(logged.filter(entry => ALREADY_ANSWERED.includes(entry.msg))).toEqual([])
    expect(logged.some(entry => entry.msg === 'OIDC callback failed')).toBe(true)

    await app.close()
  })

  // An `onSend` hook that awaits holds onFail's redirect open; the route must not send its own answer over it.
  it('leaves the response to onFail under an onSend hook that awaits', async () => {
    const runs = { n: 0 }
    const app = application(ctx => {
      ctx.redirect('/sign-in?failed=1', 303)
    }).with(() => new SlowSend(runs))
    await app.bootstrap()

    const res = await app.request('/oidc/callback?error=access_denied&state=abc')

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/sign-in?failed=1')
    expect(runs.n).toBe(1)

    await app.close()
  })

  // The way `onChallenge` and `onForbid` are written: set the redirect, and leave the sending to the framework.

  it('sends the redirect onFail set up and left unsent', async () => {
    const app = application(ctx => void ctx.status(302).header('location', '/sign-in?failed=1'))
    await app.bootstrap()

    const res = await app.request('/oidc/callback?error=access_denied&state=abc')

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
    await app.bootstrap()

    const res = await app.request('/oidc/callback?error=access_denied&state=abc')
    const text = await res.text()

    expect(res.status).toBe(400)
    expect(JSON.parse(text)).toEqual({ error: 'Authentication failed', statusCode: 400 })
    expect(text).not.toContain('10.0.0.9')

    await app.close()
  })

  it('answers a generic 400 when onFail only took note', async () => {
    const onFail = vi.fn()
    const app = application(onFail)
    await app.bootstrap()

    const res = await app.request('/oidc/callback?error=access_denied&error_description=jane%40example.com&state=abc')
    const text = await res.text()

    expect(res.status).toBe(400)
    expect(JSON.parse(text)).toEqual({ error: 'Authentication failed', statusCode: 400 })
    expect(text).not.toContain('jane')
    expect(onFail).toHaveBeenCalledOnce()

    await app.close()
  })
})
