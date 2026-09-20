import { CaffeineIoC, Configuration, Injectable, Profile, Provides, token } from '@caffeinejs/di'
import { SignJWT, generateKeyPair } from 'jose'
import { describe, it, expect } from 'vitest'

import { JWTService, JWTServiceBuilder } from './jwt_service.js'
import type { JWTKeyResolver } from './jwt_service_options.js'

const SECRET = 'test-secret-key-must-be-at-least-32-chars!!'

describe('JWTService (symmetric)', () => {
  const jwt = new JWTServiceBuilder().secret(SECRET).issuer('caffeine').audience('petstore').expiresIn('1h').build()

  it('signs and verifies a round-trip payload', async () => {
    const token = await jwt.sign({ sub: 'u1', roles: ['write:pets'] })
    const payload = await jwt.verify(token)

    expect(payload.sub).toBe('u1')
    expect(payload.roles).toEqual(['write:pets'])
    expect(payload.iss).toBe('caffeine')
    expect(payload.aud).toBe('petstore')
  })

  it('decode returns the payload without verifying the signature', async () => {
    const token = await jwt.sign({ sub: 'u2' })
    // A service with a different secret cannot verify, but decode never checks the signature.
    const other = new JWTServiceBuilder().secret('a-completely-different-secret-value-x').build()

    expect(other.decode(token).sub).toBe('u2')
    await expect(other.verify(token)).rejects.toThrow()
  })

  it('rejects an expired token (negative expiresIn = seconds in the past)', async () => {
    const token = await jwt.sign({ sub: 'u3' }, { expiresIn: -10 })
    await expect(jwt.verify(token)).rejects.toThrow()
  })

  it('treats a positive expiresIn number as seconds from now', async () => {
    const before = Math.floor(Date.now() / 1000)
    const token = await jwt.sign({ sub: 'u3b' }, { expiresIn: 3600 })
    const payload = await jwt.verify(token)

    expect(payload.exp).toBeGreaterThanOrEqual(before + 3600 - 2)
    expect(payload.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3600 + 2)
  })

  it('rejects a token whose notBefore is in the future', async () => {
    const token = await jwt.sign({ sub: 'u3c' }, { notBefore: 60 })
    await expect(jwt.verify(token)).rejects.toThrow()
  })

  it('rejects an issuer mismatch', async () => {
    const token = await jwt.sign({ sub: 'u4' }, { issuer: 'someone-else' })
    await expect(jwt.verify(token)).rejects.toThrow()
  })

  it('rejects an audience mismatch', async () => {
    const token = await jwt.sign({ sub: 'u5' }, { audience: 'another-app' })
    await expect(jwt.verify(token)).rejects.toThrow()
  })

  it('verifies more than once with the one imported key', async () => {
    const token = await jwt.sign({ sub: 'u1' })

    expect((await jwt.verify(token)).sub).toBe('u1')
    expect((await jwt.verify(token)).sub).toBe('u1')
  })
})

describe('JWTService — a token that never expires', () => {
  const jwt = new JWTServiceBuilder().secret(SECRET).issuer('caffeine').audience('petstore').build()

  // It could never be revoked, and a copy of it would work for as long as the key does.
  it('refuses to sign one', async () => {
    await expect(jwt.sign({ sub: 'u1' })).rejects.toThrow(/no "expiresIn"/)
  })

  it('signs when the call gives the lifetime the service has no default for', async () => {
    const token = await jwt.sign({ sub: 'u1' }, { expiresIn: '5m' })

    expect((await jwt.verify(token)).exp).toBeGreaterThan(Date.now() / 1000)
  })

  // jose checks an expiry only when there is one, so a correctly signed token without `exp` used to verify.
  it('refuses to verify one, however well it is signed', async () => {
    const eternal = await new SignJWT({ sub: 'u1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('caffeine')
      .setAudience('petstore')
      .sign(new TextEncoder().encode(SECRET))

    await expect(jwt.verify(eternal)).rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 'exp' })
    // Asked for by name, it is still possible.
    expect((await jwt.verify(eternal, { requiredClaims: [] })).sub).toBe('u1')
  })

  // Requiring one more claim is tightening the check. Were the caller's list to replace the default, asking for
  // `sub` would stop asking for `exp` without anyone having said so.
  it('still refuses one when the caller requires another claim as well', async () => {
    const eternal = await new SignJWT({ sub: 'u1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('caffeine')
      .setAudience('petstore')
      .sign(new TextEncoder().encode(SECRET))

    await expect(jwt.verify(eternal, { requiredClaims: ['sub'] })).rejects.toMatchObject({
      code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
      claim: 'exp',
    })
  })

  it('requires what the caller asked for on top of the expiry', async () => {
    const withoutSubject = await jwt.sign({ scope: 'read' }, { expiresIn: '5m' })

    await expect(jwt.verify(withoutSubject, { requiredClaims: ['sub'] })).rejects.toMatchObject({
      code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
      claim: 'sub',
    })
  })
})

describe('JWTService — the strength of a symmetric secret', () => {
  // RFC 7518 §3.2: a key shorter than the hash can be searched for offline, and whoever finds it signs any identity.
  it.each([
    ['HS256', 31],
    ['HS384', 47],
    ['HS512', 63],
  ])('refuses a secret for %s of %i bytes', (algorithm, bytes) => {
    expect(() => new JWTService({ secret: 'x'.repeat(bytes), algorithm })).toThrow(/must be at least \d+ bytes/)
  })

  it.each([
    ['HS256', 32],
    ['HS384', 48],
    ['HS512', 64],
  ])('accepts a secret for %s of %i bytes', (algorithm, bytes) => {
    expect(() => new JWTService({ secret: 'x'.repeat(bytes), algorithm })).not.toThrow()
  })

  it('counts bytes, not characters', () => {
    expect(() => new JWTService({ secret: new Uint8Array(31) })).toThrow(/at least 32 bytes, got 31/)
    expect(() => new JWTService({ secret: new Uint8Array(32) })).not.toThrow()
  })

  // A symmetric key can also arrive already imported, which is how the bearer scheme hands over a `CryptoKey`
  // secret: in the place of the public key. It is the same key and as easy to search for when it is short.
  it('holds an imported HMAC key to the same length', async () => {
    const imported = (bytes: number) =>
      crypto.subtle.importKey('raw', new Uint8Array(bytes).fill(7), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
        'verify',
      ])

    const short = await imported(16)
    expect(() => new JWTService({ publicKey: short, algorithm: 'HS256' })).toThrow(/at least 32 bytes, got 16/)
    expect(() => new JWTService({ privateKey: short, publicKey: short, algorithm: 'HS256' })).toThrow(
      /at least 32 bytes/,
    )

    const long = await imported(32)
    expect(() => new JWTService({ publicKey: long, algorithm: 'HS256' })).not.toThrow()
  })

  it('holds raw bytes given in the place of a key pair to the same length', () => {
    expect(() => new JWTService({ publicKey: new Uint8Array(16), algorithm: 'HS256' })).toThrow(/at least 32 bytes/)
  })
})

describe('JWTService (asymmetric)', () => {
  it('signs with the private key and verifies with the public key', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    const jwt = new JWTServiceBuilder().keys(privateKey, publicKey).algorithm('ES256').expiresIn('1h').build()

    const token = await jwt.sign({ sub: 'u1' })
    expect((await jwt.verify(token)).sub).toBe('u1')
  })

  it('throws when signing a verify-only (public-key-only) service', async () => {
    const { publicKey } = await generateKeyPair('ES256')
    const jwt = new JWTService({ publicKey, algorithm: 'ES256', expiresIn: '1h' })

    await expect(jwt.sign({ sub: 'u1' })).rejects.toThrow('Cannot sign JWT')
  })

  it('throws when an asymmetric key pair has no algorithm', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    expect(() => new JWTService({ privateKey, publicKey })).toThrow('algorithm')
  })
})

describe('JWTService (dynamic keys via keyResolver)', () => {
  const secrets: Record<string, Uint8Array> = {
    k1: new TextEncoder().encode('dynamic-secret-one-at-least-32-chars!!'),
    k2: new TextEncoder().encode('dynamic-secret-two-at-least-32-chars!!'),
  }
  // sign picks by the `tid` claim; verify picks by the token header `kid`. async to exercise the Promise path.
  const resolver: JWTKeyResolver = ctx =>
    Promise.resolve(secrets[String(ctx.operation === 'sign' ? ctx.payload?.tid : ctx.protectedHeader?.kid)])

  const jwt = new JWTServiceBuilder().keyResolver(resolver).algorithm('HS256').expiresIn('1h').build()

  it('signs and verifies with the resolver-selected key', async () => {
    const token = await jwt.sign({ sub: 'u', tid: 'k1' }, { header: { kid: 'k1' } })
    expect((await jwt.verify(token)).sub).toBe('u')
  })

  it('rejects when the verify key (by kid) differs from the signing key', async () => {
    // signed with secrets.k2 (tid), but the header kid points verify at secrets.k1
    const token = await jwt.sign({ sub: 'u', tid: 'k2' }, { header: { kid: 'k1' } })
    await expect(jwt.verify(token)).rejects.toThrow()
  })

  // Defaulted to HS256, a resolver handing back a public key as bytes would verify any token signed with it.
  it('refuses a resolver that comes with no algorithm', () => {
    expect(() => new JWTServiceBuilder().keyResolver(resolver).build()).toThrow(/"algorithm" is required/)
  })

  it('throws when the resolver yields no signing key', async () => {
    await expect(jwt.sign({ sub: 'u', tid: 'unknown' })).rejects.toThrow('Cannot sign JWT')
  })
})

describe('JWTService via @Configuration/@Provides', () => {
  @Configuration()
  @Profile('jwt-service-test')
  class JWTConfig {
    @Provides(JWTService, token<JWTService>('jwt-access'))
    access(): JWTService {
      return new JWTServiceBuilder()
        .secret('access-secret-value-for-tests-xxxxxx')
        .issuer('access')
        .expiresIn('15m')
        .build()
    }

    @Provides(JWTService, token<JWTService>('jwt-refresh'))
    refresh(): JWTService {
      return new JWTServiceBuilder().secret('refresh-secret-value-for-tests-xxxxx').issuer('refresh').build()
    }
  }

  @Injectable([token<JWTService>('jwt-access')])
  @Profile('jwt-service-test')
  class TokenIssuer {
    constructor(readonly jwt: JWTService) {}
  }

  void [JWTConfig, TokenIssuer]

  it('resolves multiple named services and injects the requested one', async () => {
    const di = new CaffeineIoC({ profiles: ['jwt-service-test'] })
    await di.init()

    const access = di.get(token<JWTService>('jwt-access'))
    const refresh = di.get(token<JWTService>('jwt-refresh'))
    expect(access).toBeInstanceOf(JWTService)
    expect(refresh).toBeInstanceOf(JWTService)
    expect(access).not.toBe(refresh)

    const issuer = di.get(TokenIssuer)
    expect(issuer.jwt).toBe(access)

    const signed = await issuer.jwt.sign({ sub: 'u1' })
    expect((await access.verify(signed)).iss).toBe('access')
    await expect(refresh.verify(signed)).rejects.toThrow()
  })
})
