import { describe, it, expect, vi } from 'vitest'
import type { Context } from '../../../context.js'
import { Claim } from '../../index.js'
import { AuthenticationBuilder } from '../builder.js'
import { ForwardAuthenticationHandler } from '../forward/forward.js'
import { kConfigure, type ServiceKit } from '../../../service.js'
import { claimsToSession, encodeSession } from '../internal/remote/session_store.js'
import { encodeState } from '../internal/remote/state_store.js'
import { OidcAuthenticationHandler } from './handler.js'
import { resolveOidcOptions, sanitizeSchemeName } from './options.js'

const SESSION_SECRET = 'multi-idp-test-secret-at-least-32ch!!'
const GOOGLE = 'https://accounts.google.example.com'
const OKTA = 'https://okta.example.com'

function optionsFor(issuer: string, overrides: Record<string, unknown> = {}) {
  return {
    clientId: 'client',
    clientSecret: 'secret',
    sessionSecret: SESSION_SECRET,
    callbackUrl: `https://app.example.com/auth/${issuer.includes('okta') ? 'okta' : 'google'}`,
    discoveryUrl: issuer,
    issuer,
    ...overrides,
  }
}

function makeCtx(cookies: Record<string, string> = {}) {
  return {
    req: {
      url: '/dashboard',
      cookie: (name?: string) => name === undefined ? cookies : cookies[name],
      query: (key?: string) => key === undefined ? {} : undefined,
      header: () => undefined,
    },
    cookie: vi.fn().mockReturnThis(),
    deleteCookie: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  } as unknown as Context
}

/** Minimal ServiceKit double — configure only touches the container and the feature flags. */
function makeKit(): ServiceKit {
  const bindings = new Map<unknown, unknown>()
  const binding = (key: unknown) => ({
    toValue: (v: unknown) => {
      bindings.set(key, v)
      return { internal: () => undefined }
    },
  })
  return {
    container: {
      bind: binding,
      wrap: (v: unknown) => ({ get: () => v }),
    },
    feats: { toggleAuthentication: () => undefined },
  } as unknown as ServiceKit
}

async function configure(build: (b: AuthenticationBuilder) => void): Promise<void> {
  const builder = new AuthenticationBuilder()
  build(builder)
  await builder[kConfigure](makeKit())
}

/**
 * T-MULTI-01 / T-MULTI-05: the isolation guarantee, stated on defaults alone.
 *
 * Two strategies configured with nothing but their own client details — the same
 * `sessionSecret`, because in practice it comes from one environment variable — must not be
 * able to touch each other's cookies.
 */
describe('two OIDC strategies on default configuration', () => {
  const google = new OidcAuthenticationHandler('Google', optionsFor(GOOGLE))
  const okta = new OidcAuthenticationHandler('Okta', optionsFor(OKTA))

  it('T-MULTI-01: writes to different cookie names', () => {
    expect(google.sessionCookieName).toBe('__Host-oidc_Google_session')
    expect(okta.sessionCookieName).toBe('__Host-oidc_Okta_session')
    expect(google.stateCookieName).not.toBe(okta.stateCookieName)
  })

  it('T-MULTI-05: cannot read the other strategy\'s session even sharing a secret', async () => {
    const session = claimsToSession([new Claim('sub', 'u1', GOOGLE)], 'Google')
    const cookie = await encodeSession(session, SESSION_SECRET, 'Google', 3600)

    // Presented under Okta's own cookie name, so the name check cannot be what rejects it.
    const result = await okta.authenticate(makeCtx({ [okta.sessionCookieName]: cookie }))

    expect(result.succeeded).toBe(false)
    // The HKDF info differs, so this fails at decryption — before any payload is parsed.
    expect(result.error).toBeInstanceOf(Error)
  })

  it('T-MULTI-05: cannot read the other strategy\'s state cookie', async () => {
    const state = await encodeState(
      {
        state: 's', nonce: 'n', codeVerifier: 'cv', pkceMethod: 'S256',
        returnTo: '/', scheme: 'Google', issuer: GOOGLE,
      },
      SESSION_SECRET,
      'Google',
    )

    await expect(
      encodeState({
        state: 's', nonce: 'n', codeVerifier: 'cv', pkceMethod: 'S256',
        returnTo: '/', scheme: 'Okta', issuer: OKTA,
      }, SESSION_SECRET, 'Okta'),
    ).resolves.not.toBe(state)
  })

  it('T-MULTI-04: a session naming another scheme is not this handler\'s to accept', async () => {
    // Sealed with Okta's key so it decrypts, but claiming Google inside. The payload check is
    // the backstop for a deployment that shares cookie names between strategies.
    const session = claimsToSession([new Claim('sub', 'u1', GOOGLE)], 'Google')
    const cookie = await encodeSession(session, SESSION_SECRET, 'Okta', 3600)

    const result = await okta.authenticate(makeCtx({ [okta.sessionCookieName]: cookie }))

    expect(result.succeeded).toBe(false)
    // none(), not fail(): it is simply not this strategy's credential.
    expect(result.error).toBeUndefined()
  })

  it('accepts its own session', async () => {
    const session = claimsToSession([new Claim('sub', 'u1', OKTA)], 'Okta')
    const cookie = await encodeSession(session, SESSION_SECRET, 'Okta', 3600)

    const result = await okta.authenticate(makeCtx({ [okta.sessionCookieName]: cookie }))

    expect(result.succeeded).toBe(true)
    expect(result.ticket!.principal.findFirst('sub')?.value).toBe('u1')
  })
})

describe('cookie name derivation', () => {
  it('sanitizes characters a cookie name cannot carry', () => {
    const handler = new OidcAuthenticationHandler('My IdP', optionsFor(GOOGLE))
    expect(handler.sessionCookieName).toBe('__Host-oidc_My_IdP_session')
  })

  it.each(['My IdP', 'a@b.c', 'ünïcode'])('always produces a legal cookie name (%j)', name => {
    expect(sanitizeSchemeName(name)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('rejects a name that sanitizes to nothing usable', () => {
    expect(() => sanitizeSchemeName('   ')).toThrow('no characters usable in a cookie name')
    expect(() => sanitizeSchemeName('')).toThrow('no characters usable in a cookie name')
  })

  it('drops the __Host- prefix over http, where it is illegal', () => {
    const handler = new OidcAuthenticationHandler('Dev', optionsFor(GOOGLE, {
      callbackUrl: 'http://localhost:3000/cb',
    }))
    expect(handler.sessionCookieName).toBe('__oidc_Dev_session')
  })
})

describe('startup validation', () => {
  const addOidc = (b: AuthenticationBuilder, name: string, issuer: string, overrides = {}) =>
    b.addOidc(name, o => {
      const opts = optionsFor(issuer, overrides)
      o.clientId(opts.clientId).clientSecret(opts.clientSecret)
        .sessionSecret(opts.sessionSecret).callbackUrl(opts.callbackUrl)
        .discoveryUrl(opts.discoveryUrl)
        .issuer(opts.issuer)
      if ('sessionCookieName' in opts) {
        o.sessionCookieName(opts.sessionCookieName as string)
      }
    })

  it('T-MULTI-02: rejects two strategies sharing a callback path', async () => {
    await expect(configure(b => {
      addOidc(b, 'Google', GOOGLE)
      addOidc(b, 'Okta', OKTA, { callbackUrl: 'https://app.example.com/auth/google' })
      b.forward('auth', () => 'Google').default('auth')
    })).rejects.toThrow(/share the callbackPath/)
  })

  it('rejects two strategies sharing an explicit session cookie name', async () => {
    await expect(configure(b => {
      addOidc(b, 'Google', GOOGLE, { sessionCookieName: 'shared' })
      addOidc(b, 'Okta', OKTA, { sessionCookieName: 'shared' })
      b.forward('auth', () => 'Google').default('auth')
    })).rejects.toThrow(/share the session cookie name "shared"/)
  })

  it('names both offending strategies', async () => {
    await expect(configure(b => {
      addOidc(b, 'Google', GOOGLE, { sessionCookieName: 'shared' })
      addOidc(b, 'Okta', OKTA, { sessionCookieName: 'shared' })
      b.forward('auth', () => 'Google').default('auth')
    })).rejects.toThrow(/"Google" and "Okta"/)
  })

  it('T-MULTI-07: rejects several OIDC strategies without a Forward default', async () => {
    await expect(configure(b => {
      addOidc(b, 'Google', GOOGLE)
      addOidc(b, 'Okta', OKTA)
      b.default('Google')
    })).rejects.toThrow(/require a Forward default authenticate scheme/)
  })

  it('T-MULTI-08: accepts several OIDC strategies behind a Forward default', async () => {
    await expect(configure(b => {
      addOidc(b, 'Google', GOOGLE)
      addOidc(b, 'Okta', OKTA)
      b.forward('auth', () => 'Google').default('auth')
    })).resolves.toBeUndefined()
  })

  // A misspelled default resolved to undefined, which made the Forward check a no-op — the
  // broken config passed startup and failed only at request time. It must be rejected here.
  it('T-MULTI-08b: rejects a default scheme that names no registered strategy', async () => {
    await expect(configure(b => {
      addOidc(b, 'Google', GOOGLE)
      addOidc(b, 'Okta', OKTA)
      b.forward('auth', () => 'Google').default('AuthTypo')
    })).rejects.toThrow(/"AuthTypo" is not a registered strategy/)
  })

  // #11: two handlers sharing a name derive their sealed-cookie keys from the same HKDF
  // namespace. Distinct cookie names (the protocol prefix differs) hide the collision from the
  // other checks, so name uniqueness is enforced directly.
  it('T-MULTI-08c: rejects two OAuth strategies sharing a name', async () => {
    await expect(configure(b => {
      addOidc(b, 'Duplicate', GOOGLE)
      addOidc(b, 'Duplicate', OKTA, { callbackUrl: 'https://app.example.com/auth/okta' })
      b.forward('auth', () => 'Duplicate').default('auth')
    })).rejects.toThrow(/two OAuth strategies share the name "Duplicate"/)
  })

  it('does not require Forward for a single OIDC strategy', async () => {
    await expect(configure(b => {
      addOidc(b, 'Google', GOOGLE)
      b.default('Google')
    })).resolves.toBeUndefined()
  })

  /**
   * T-MULTI-09, the inverse of a rule the original brief wanted.
   *
   * One provider with two client registrations — separate audiences, separate consent
   * screens — is a normal deployment. It is safe here precisely because cookies, callback
   * paths and derived keys are all distinct, so rejecting it would cost a real use case and
   * buy nothing.
   */
  it('T-MULTI-09: allows two strategies against the same issuer', async () => {
    await expect(configure(b => {
      b.addOidc('Users', o => o.clientId('users-client').clientSecret('s')
        .sessionSecret(SESSION_SECRET).callbackUrl('https://app.example.com/auth/users')
        .discoveryUrl(GOOGLE)
        .issuer(GOOGLE))
      b.addOidc('Admins', o => o.clientId('admins-client').clientSecret('s')
        .sessionSecret(SESSION_SECRET).callbackUrl('https://app.example.com/auth/admins')
        .discoveryUrl(GOOGLE)
        .issuer(GOOGLE))
      b.forward('auth', () => 'Users').default('auth')
    })).resolves.toBeUndefined()
  })
})

/**
 * T-FWD-01. `forward()` was dead code: `[kConfigure]` looked for a
 * `ForwardAuthenticationHandler` while iterating the wrapped providers, so the `instanceof`
 * never matched, `setSchemeProvider` never ran, and the first request through a forwarded
 * scheme threw on an undefined provider. Nothing exercised it end to end, so it stayed broken
 * — and requiring Forward as the multi-OIDC default depends on it working.
 */
describe('Forward wiring through configure', () => {
  it('T-FWD-01: routes to the selected scheme with no manual setSchemeProvider', async () => {
    const target = {
      authenticate: vi.fn().mockResolvedValue({ succeeded: true, ticket: 'ticket' }),
      challenge: vi.fn(),
      forbid: vi.fn(),
      persist: vi.fn(),
      revoke: vi.fn(),
    }
    const forward = new ForwardAuthenticationHandler(() => 'Target')

    const builder = new AuthenticationBuilder()
    builder.addStrategy('Target', target as never)
    builder.addStrategy('auth', forward)
    builder.default('auth')
    await builder[kConfigure](makeKit())

    // Before the fix this threw reading `defaultAuthenticateScheme` of undefined.
    await expect(forward.authenticate(makeCtx())).resolves.toMatchObject({ succeeded: true })
    expect(target.authenticate).toHaveBeenCalledOnce()
  })

  it('T-FWD-01: the same wiring reaches a handler registered via forward()', async () => {
    const target = {
      authenticate: vi.fn().mockResolvedValue({ succeeded: true }),
      challenge: vi.fn(),
      forbid: vi.fn(),
      persist: vi.fn(),
      revoke: vi.fn(),
    }

    await expect(configure(b => {
      b.addStrategy('Target', target as never)
      b.forward('auth', () => 'Target')
      b.default('auth')
    })).resolves.toBeUndefined()
  })
})

describe('configuration hardening', () => {
  it('T-MULTI-06: rejects a non-loopback http callbackUrl', () => {
    expect(() => resolveOidcOptions(optionsFor(GOOGLE, {
      callbackUrl: 'http://app.example.com/cb',
    }), 'Google')).toThrow('must use https')
  })

  it('T-MULTI-06: allows http on loopback for local development', () => {
    expect(() => resolveOidcOptions(optionsFor(GOOGLE, {
      callbackUrl: 'http://localhost:3000/cb',
    }), 'Google')).not.toThrow()
  })

  it('requires a pinned issuer alongside discoveryUrl', () => {
    const { issuer, ...withoutIssuer } = optionsFor(GOOGLE)
    void issuer
    expect(() => resolveOidcOptions(withoutIssuer as never, 'Google'))
      .toThrow('issuer is required when discoveryUrl is set')
  })
})
