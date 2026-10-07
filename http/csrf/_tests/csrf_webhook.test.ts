import { createHmac, timingSafeEqual } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  Authentication,
  Authorization,
  BaseAuthenticationHandler,
  Controller,
  CSRFExempt,
  ErrHTTPUnauthorized,
  Post,
  authentication,
  bodyAsBuffer,
  createWebApplication,
  csrf,
  csrfExempt,
  newRouter,
  type Context,
} from '../../index.js'

/**
 * A webhook receiver behind `csrf()`: what a provider's delivery looks like, what a forgery from a victim's browser
 * looks like, and what an exemption hands over to the receiver.
 *
 * The receiver checks an HMAC over the bytes it was sent, as GitHub and Stripe ask, so a delivery the check lets
 * through still has to prove where it came from.
 */

const SECRET = 'whsec_test'

/** What GitHub's servers send: no Fetch Metadata and no Origin, since no browser is involved. */
const GITHUB: Record<string, string> = {
  'content-type': 'application/json',
  'user-agent': 'GitHub-Hookshot/7f3c2d1',
  'x-github-event': 'push',
}

/** A form-encoded delivery, as Twilio and Slack post theirs. */
const FORM_DELIVERY: Record<string, string> = {
  'content-type': 'application/x-www-form-urlencoded',
  'user-agent': 'TwilioProxy/1.1',
}

/** A form on another site, posting to the receiver from a victim's browser. */
const FORGED: Record<string, string> = {
  'content-type': 'application/x-www-form-urlencoded',
  origin: 'https://evil.example',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
}

/** A sender that sets an Origin of its own on a server-to-server delivery. */
const SENDER_WITH_ORIGIN: Record<string, string> = {
  'content-type': 'application/json',
  origin: 'https://hooks.partner.example',
}

/** A payment provider sending the user's browser back with a form after 3-D Secure: `null` after its redirects. */
const THREE_DS_RETURN: Record<string, string> = {
  'content-type': 'application/x-www-form-urlencoded',
  origin: 'null',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
}

/** `X-Hub-Signature-256`, as GitHub writes it. */
function sign(body: string | Buffer): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`
}

function signedOver(body: Buffer, signature: string | undefined): boolean {
  const expected = Buffer.from(sign(body))
  const given = Buffer.from(signature ?? '')

  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** `POST /webhooks/github`, which takes a delivery only when its signature covers the bytes it was sent. */
function github(accepted: unknown[], router = newRouter('/webhooks')) {
  return router
    .post('/github')
    .with(bodyAsBuffer())
    .handler(ctx => {
      const body = ctx.req.body() as Buffer
      if (!signedOver(body, ctx.req.header('x-hub-signature-256'))) {
        throw new ErrHTTPUnauthorized('Cannot accept the delivery: its signature does not match')
      }

      accepted.push(JSON.parse(body.toString()))
      return { ok: true }
    })
}

const ok = () => ({ ok: true })

interface Fetching {
  fetch(url: string, init?: RequestInit): Promise<Response>
}

function deliver(app: Fetching, path: string, body: string, headers: Record<string, string>, method = 'POST') {
  return app.fetch(path, { method, headers, body })
}

describe('csrf() in front of a webhook receiver', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function ready<A extends { bootstrap(): Promise<unknown>; close(): Promise<unknown> }>(app: A): Promise<A> {
    close = () => app.close()
    await app.bootstrap()
    return app
  }

  // A server holds no victim's cookies and sends neither header: the check has nothing to say, so the receiver needs
  // no configuration, and its own signature check is what decides.
  it('takes a JSON delivery from a server with no configuration, leaving the signature to the receiver', async () => {
    const accepted: unknown[] = []
    const app = await ready(createWebApplication().with(csrf()).mount(github(accepted)))
    // Spacing a re-serialised body would lose: the signature covers these bytes, which reach the receiver as sent.
    const body = '{"zen":"Keep it logically awesome.",  "hook_id":1}'

    expect(
      (await deliver(app, '/webhooks/github', body, { ...GITHUB, 'x-hub-signature-256': sign(body) })).status,
    ).toBe(200)
    const tampered = await deliver(app, '/webhooks/github', body, {
      ...GITHUB,
      'x-hub-signature-256': sign(`${body} `),
    })

    expect(tampered.status).toBe(401)
    expect(await tampered.json()).toMatchObject({ code: 'ERR_HTTP_UNAUTHORIZED' })
    expect(accepted).toEqual([{ zen: 'Keep it logically awesome.', hook_id: 1 }])
  })

  // Content type does not decide: a form-encoded delivery is still a server's, carrying neither header.
  it('takes a form-encoded delivery from a server with no configuration', async () => {
    const received: unknown[] = []
    const twilio = newRouter('/webhooks/twilio').post('/', ctx => {
      received.push({ ...(ctx.req.body() as object) })
      return ok()
    })

    const app = await ready(createWebApplication().with(csrf()).mount(twilio))
    const res = await deliver(app, '/webhooks/twilio', 'MessageSid=SM123&Body=hello', FORM_DELIVERY)

    expect(res.status).toBe(200)
    expect(received).toEqual([{ MessageSid: 'SM123', Body: 'hello' }])
  })

  // Every unsafe method and every content type is checked, so no spelling of a forgery reaches the receiver.
  it("refuses a forged delivery from a victim's browser, whatever its method or content type", async () => {
    let handled = 0
    const count = () => (handled++, ok())
    const receiver = newRouter('/webhooks/github').post('/', count).put('/', count).patch('/', count).delete('/', count)

    const app = await ready(createWebApplication().with(csrf()).mount(receiver))

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'application/json']) {
        const res = await deliver(app, '/webhooks/github', 'zen=forged', { ...FORGED, 'content-type': type }, method)

        expect(res.status, `${method} ${type}`).toBe(403)
        expect(await res.json(), `${method} ${type}`).toMatchObject({ code: 'ERR_CSRF_CROSS_ORIGIN' })
      }
    }
    expect(handled).toBe(0)
  })

  // A forgery costs nothing past its headers: refused before a body parser, or a body limit, ever sees it.
  it('refuses a forged delivery before reading its body: 403, not 413', async () => {
    let parsed = 0
    const parsing = () =>
      fp(
        async (instance: FastifyInstance) => {
          instance.addHook('preParsing', async (_request, _reply, payload) => {
            parsed++
            return payload
          })
        },
        { name: 'parsing' },
      )

    const app = await ready(
      createWebApplication()
        .with(csrf())
        .with(parsing)
        .mount(newRouter('/webhooks/stripe').post('/').bodyLimit(1024).handler(ok)),
    )
    const oversized = JSON.stringify({ data: 'x'.repeat(4096) })

    expect((await deliver(app, '/webhooks/stripe', oversized, FORGED)).status).toBe(403)
    expect(parsed).toBe(0)
    expect((await deliver(app, '/webhooks/stripe', oversized, GITHUB)).status).toBe(413)
    expect(parsed).toBe(1)
  })

  it('refuses a sender that sets an Origin of its own', async () => {
    const app = await ready(createWebApplication().with(csrf()).mount(newRouter('/webhooks/partner').post('/', ok)))

    expect((await deliver(app, '/webhooks/partner', '{}', SENDER_WITH_ORIGIN)).status).toBe(403)
  })

  it.each([
    [
      '@CSRFExempt()',
      '/decorated-webhooks/partner',
      () => {
        @CSRFExempt()
        @Controller('/decorated-webhooks')
        class PartnerHooks {
          @Post('/partner')
          receive() {
            return ok()
          }
        }
        void [PartnerHooks]

        return createWebApplication().with(csrf())
      },
    ],
    [
      'csrfExempt() on its router',
      '/webhooks/partner',
      () => createWebApplication().with(csrf()).mount(newRouter('/webhooks/partner').with(csrfExempt()).post('/', ok)),
    ],
    [
      'exclude() of its path',
      '/webhooks/partner',
      () =>
        createWebApplication()
          .with(csrf(c => c.exclude('/webhooks')))
          .mount(newRouter('/webhooks/partner').post('/', ok)),
    ],
  ])('takes that sender once its receiver is exempt, by %s', async (_how, path, build) => {
    const app = await ready(build())

    expect((await deliver(app, path, '{}', SENDER_WITH_ORIGIN)).status).toBe(200)
  })

  // An exemption takes the check away, not the risk: a forgery now reaches the receiver, whose signature check is
  // all that stands in its way.
  it('hands a forgery to an exempt receiver, whose signature check refuses it', async () => {
    const accepted: unknown[] = []
    const app = await ready(
      createWebApplication()
        .with(csrf(c => c.exclude('/webhooks')))
        .mount(github(accepted)),
    )
    const res = await deliver(app, '/webhooks/github', '{"zen":"forged"}', { ...FORGED, 'content-type': 'text/plain' })

    expect(res.status).toBe(401)
    expect(accepted).toEqual([])
  })

  // A callback that comes back through the user's browser is cross-site, and `null` after a redirect: no origin to
  // trust, and no check may take it, so only an exemption lets it in.
  it('refuses a return through the browser with Origin: null, unless its route is exempt', async () => {
    const payment = 'PaRes=eJzVWNt&MD=4af1'
    const trusting = await ready(
      createWebApplication()
        .with(csrf(c => c.trustedOrigins('https://acs.bank.example').trustOrigin(() => true)))
        .mount(newRouter('/payments').post('/return', ok)),
    )

    expect((await deliver(trusting, '/payments/return', payment, THREE_DS_RETURN)).status).toBe(403)
    await close?.()

    const exempt = await ready(
      createWebApplication().with(csrf()).mount(newRouter('/payments').post('/return').with(csrfExempt()).handler(ok)),
    )

    expect((await deliver(exempt, '/payments/return', payment, THREE_DS_RETURN)).status).toBe(200)
  })

  // The route that rotates the signing secret sits beside the receiver, and is exactly what a forgery would want.
  it('keeps the routes beside an exempt receiver protected', async () => {
    const body = '{"zen":"Approachable is better than simple."}'
    const delivery = { ...GITHUB, origin: 'https://hooks.partner.example', 'x-hub-signature-256': sign(body) }
    const settings = (router = newRouter('/webhooks/settings')) => router.post('/', ok)

    const narrow = await ready(
      createWebApplication()
        .with(csrf(c => c.exclude('/webhooks/github')))
        .mount(github([]), settings()),
    )

    expect((await deliver(narrow, '/webhooks/github', body, delivery)).status).toBe(200)
    expect((await deliver(narrow, '/webhooks/settings', 'secret=rotate', FORGED)).status).toBe(403)
    await close?.()

    const wide = await ready(
      createWebApplication()
        .with(csrf(c => c.exclude('/webhooks')))
        .mount(github([]), settings(newRouter('/webhooks/settings').with(csrfExempt(false)))),
    )

    expect((await deliver(wide, '/webhooks/github', body, delivery)).status).toBe(200)
    expect((await deliver(wide, '/webhooks/settings', 'secret=rotate', FORGED)).status).toBe(403)
  })

  it('writes an exclusion without the base path', async () => {
    const app = await ready(
      createWebApplication()
        .basePath('/api')
        .with(csrf(c => c.exclude('/webhooks')))
        .mount(newRouter('/webhooks/stripe').post('/', ok), newRouter('/webhooksx').post('/', ok)),
    )

    expect((await deliver(app, '/api/webhooks/stripe', '{}', SENDER_WITH_ORIGIN)).status).toBe(200)
    expect((await deliver(app, '/webhooks/stripe', '{}', SENDER_WITH_ORIGIN)).status).toBe(200)
    expect((await deliver(app, '/api/webhooksx', '{}', SENDER_WITH_ORIGIN)).status).toBe(403)
  })

  /** Authenticates nobody: what a webhook sender, holding no session, meets at the gate. */
  class Nobody extends BaseAuthenticationHandler<object> {
    constructor() {
      super({})
    }

    async authenticate(): Promise<AuthenticateResult> {
      return AuthenticateResult.none()
    }

    override async challenge(ctx: Context): Promise<void> {
      ctx.status(401)
    }
  }

  // Exempting a receiver from the check says nothing of who may call it: the gate still asks for a principal until
  // the receiver is declared public.
  it('does not exempt a receiver from authentication by exempting it from the check', async () => {
    const body = '{"zen":"Design for failure."}'
    const delivery = { ...SENDER_WITH_ORIGIN, 'x-hub-signature-256': sign(body) }
    const gated = () =>
      createWebApplication()
        .install(Authentication(a => a.addStrategy('Nobody', new Nobody()).default('Nobody')))
        .install(Authorization(z => z.requireAuthenticatedByDefault()))
        .with(csrf(c => c.exclude('/webhooks')))
        .with(authentication())

    const protectedReceiver = await ready(gated().mount(github([])))

    expect((await deliver(protectedReceiver, '/webhooks/github', body, delivery)).status).toBe(401)
    await close?.()

    const accepted: unknown[] = []
    const publicReceiver = await ready(
      gated().mount(github(accepted, newRouter('/webhooks').authorize({ allowAnonymous: true }))),
    )

    expect((await deliver(publicReceiver, '/webhooks/github', body, delivery)).status).toBe(200)
    expect(accepted).toEqual([{ zen: 'Design for failure.' }])
  })
})
