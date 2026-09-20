import { createHmac, createPublicKey, type JsonWebKeyInput } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { newRouter } from '@caffeinejs/http'
import { createRemoteJWKSet } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { Browser, type BrowserResponse } from './internal/browser/index.js'
import type { JWTOptionsBuilder } from './internal/builders.js'
import { OAUTH_SERVER, clientCredentialsToken, oauthServerUp } from './internal/spring/index.js'
import { required } from './internal/strict.js'

/**
 * The application as a resource server: it issues nothing, and accepts the RS256 access tokens a real
 * authorization server signed, verified against that server's published keys.
 */

const API = 'caffeine-api'
const SHORT_LIVED = 'caffeine-api-short'
const OTHER = 'caffeine-other'

const JWKS_URI = `${OAUTH_SERVER}/oauth2/jwks`

function resourceServer(j: JWTOptionsBuilder, issuer = OAUTH_SERVER): JWTOptionsBuilder {
  const jwks = createRemoteJWKSet(new URL(JWKS_URI))

  return j
    .keyResolver(({ protectedHeader }) => jwks(protectedHeader))
    .algorithm('RS256')
    .issuer(issuer)
    .audience([API, SHORT_LIVED])
}

function routes() {
  return newRouter().mount(
    newRouter('/whoami')
      .authorize({})
      .get('/', ctx => ({ sub: ctx.user.findFirst('sub')?.value, scope: ctx.user.findFirst('scope')?.value })),
    newRouter('/service')
      .authorize({ roles: ['service'] })
      .get('/', () => ({ ok: true })),
    newRouter('/admin')
      .authorize({ roles: ['admin'] })
      .get('/', () => ({ ok: true })),
  )
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decode<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T
}

/** The authorization server's signing key, as the PEM anyone can download. */
async function publishedPublicKeyPEM(kid: string): Promise<string> {
  const { keys } = (await (await fetch(JWKS_URI)).json()) as { keys: Array<JsonWebKeyInput['key'] & { kid?: string }> }
  const jwk = keys.find(key => key.kid === kid)
  if (jwk === undefined) {
    throw new Error(`The JWKS holds no key "${kid}"`)
  }

  return createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' }) as string
}

const up = required('oauthserver', await oauthServerUp())

describe.skipIf(!up)('JWT bearer as a resource server for Spring-issued tokens', () => {
  let running: RunningApp
  let token: string

  const get = (path: string, authorization?: string): Promise<BrowserResponse> =>
    new Browser().xhr(`${running.origin}${path}`, authorization === undefined ? {} : { headers: { authorization } })

  function expectInvalidToken(response: BrowserResponse) {
    expect(response.status).toBe(401)
    expect(response.headers['www-authenticate']).toMatch(/^Bearer error="invalid_token"/)
  }

  beforeAll(async () => {
    running = await startApp(app =>
      app.authentication(auth => auth.addJWTBearer('api', j => resourceServer(j))).mount(routes()),
    )
    token = await clientCredentialsToken(API, `${API}-secret`, 'api.read')
  })

  afterAll(() => running.close())

  it('accepts a token the authorization server signed for this audience', async () => {
    const response = await get('/whoami', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ sub: API, scope: ['api.read'] })
  })

  it('reads the scheme name case-insensitively', async () => {
    expect((await get('/whoami', `bearer ${token}`)).status).toBe(200)
    expect((await get('/whoami', `BEARER ${token}`)).status).toBe(200)
  })

  it('challenges a request without a token, and names no error because there is no token to fault', async () => {
    const response = await get('/whoami')

    expect(response.status).toBe(401)
    expect(response.headers['www-authenticate']).toBe('Bearer')
  })

  it('takes the token from the Authorization header and from nowhere else', async () => {
    const response = await new Browser().xhr(`${running.origin}/whoami?access_token=${token}`)

    expect(response.status).toBe(401)
  })

  it('authorizes by the roles the token carries', async () => {
    expect((await get('/service', `Bearer ${token}`)).status).toBe(200)
    expect((await get('/admin', `Bearer ${token}`)).status).toBe(403)
  })

  describe('refuses', () => {
    it('a string that is not a token', async () => {
      expectInvalidToken(await get('/whoami', 'Bearer not-a-jwt'))
    })

    it('a token whose signature does not match its content', async () => {
      const [header, payload, signature] = token.split('.')
      const claims = decode<Record<string, unknown>>(payload)

      // Same signature, another subject.
      const forged = [header, encode({ ...claims, sub: 'someone-else', roles: ['admin'] }), signature].join('.')

      expectInvalidToken(await get('/admin', `Bearer ${forged}`))
    })

    it('an unsigned token declaring alg "none"', async () => {
      const [, payload] = token.split('.')
      const forged = `${encode({ alg: 'none', typ: 'JWT' })}.${payload}.`

      expectInvalidToken(await get('/whoami', `Bearer ${forged}`))
    })

    // The key-confusion attack: the verification key is public, so anyone can use it as an HMAC secret. It
    // works wherever the verifier lets the token choose the algorithm.
    it('an HS256 token signed with the published public key as the secret', async () => {
      const [header, payload] = token.split('.')
      const { kid } = decode<{ kid: string }>(header)

      const signed = `${encode({ alg: 'HS256', typ: 'JWT', kid })}.${payload}`
      const signature = createHmac('sha256', await publishedPublicKeyPEM(kid))
        .update(signed)
        .digest('base64url')

      expectInvalidToken(await get('/whoami', `Bearer ${signed}.${signature}`))
    })

    it('a genuine token minted for another audience', async () => {
      const other = await clientCredentialsToken(OTHER, `${OTHER}-secret`, 'api.read')

      expectInvalidToken(await get('/whoami', `Bearer ${other}`))
    })

    it('a genuine token once it has expired', async () => {
      const shortLived = await clientCredentialsToken(SHORT_LIVED, `${SHORT_LIVED}-secret`, 'api.read')
      expect((await get('/whoami', `Bearer ${shortLived}`)).status).toBe(200)

      // The server signs these with a two-second lifetime.
      await sleep(3000)

      const response = await get('/whoami', `Bearer ${shortLived}`)
      expectInvalidToken(response)
      expect(response.headers['www-authenticate']).toContain('exp')
    })

    it('a genuine token when the issuer it names is not the one expected', async () => {
      const elsewhere = await startApp(app =>
        app
          .authentication(auth => auth.addJWTBearer('api', j => resourceServer(j, `${OAUTH_SERVER}/another-issuer`)))
          .mount(routes()),
      )

      try {
        const response = await new Browser().xhr(`${elsewhere.origin}/whoami`, {
          headers: { authorization: `Bearer ${token}` },
        })

        expectInvalidToken(response)
      } finally {
        await elsewhere.close()
      }
    })
  })
})
