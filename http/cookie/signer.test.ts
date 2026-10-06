import { sign as fastifySign, unsign as fastifyUnsign } from '@fastify/cookie'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrCookieConfiguration } from './errors.js'
import { HMACCookieSigner, MIN_COOKIE_SECRET_LENGTH, type CookieSigningAlgorithm } from './signer.js'

const SECRET = 'a-cookie-secret-of-at-least-32-characters'
const OLDER = 'an-older-cookie-secret-of-32-characters-or-more'
const OTHER = 'a-third-cookie-secret-nobody-configured-here'

const NODE_ALGORITHM: Record<CookieSigningAlgorithm, string> = {
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function signatureOf(signed: string): string {
  return signed.slice(signed.lastIndexOf('.') + 1)
}

function withSignature(signed: string, signature: string): string {
  return `${signed.slice(0, signed.lastIndexOf('.'))}.${signature}`
}

afterEach(() => {
  vi.restoreAllMocks()
})

// A cookie signed before the switch away from @fastify/cookie must still verify after it, and the reverse: a
// deployment rolling between the two keeps its users' cookies.
describe('HMACCookieSigner, against @fastify/cookie', () => {
  for (const algorithm of ['SHA-256', 'SHA-384', 'SHA-512'] as const) {
    it(`writes the signature @fastify/cookie writes, with ${algorithm}`, async () => {
      const signer = new HMACCookieSigner({ secret: SECRET, algorithm })

      expect(await signer.sign('value.with.dots')).toBe(
        fastifySign('value.with.dots', SECRET, NODE_ALGORITHM[algorithm]),
      )
    })

    it(`verifies what @fastify/cookie signs, and the other way round, with ${algorithm}`, async () => {
      const signer = new HMACCookieSigner({ secret: SECRET, algorithm })

      expect(await signer.unsign(fastifySign('theirs', SECRET, NODE_ALGORITHM[algorithm]))).toEqual({
        valid: true,
        renew: false,
        value: 'theirs',
      })
      expect(fastifyUnsign(await signer.sign('ours'), SECRET, NODE_ALGORITHM[algorithm])).toEqual({
        valid: true,
        renew: false,
        value: 'ours',
      })
    })
  }
})

describe('HMACCookieSigner', () => {
  it('signs and verifies an empty value', async () => {
    const signer = new HMACCookieSigner({ secret: SECRET })

    expect(await signer.unsign(await signer.sign(''))).toEqual({ valid: true, renew: false, value: '' })
  })

  // Rotation: the newest secret signs, an older one still verifies, and `renew` says the cookie is worth re-issuing.
  it('signs with the first secret and verifies with any, saying when an older one did', async () => {
    const signer = new HMACCookieSigner({ secret: [SECRET, OLDER] })

    expect(await signer.sign('v')).toBe(fastifySign('v', SECRET))
    expect(await signer.unsign(fastifySign('v', SECRET))).toEqual({ valid: true, renew: false, value: 'v' })
    expect(await signer.unsign(fastifySign('v', OLDER))).toEqual({ valid: true, renew: true, value: 'v' })
    expect(await signer.unsign(fastifySign('v', OTHER))).toEqual({ valid: false, renew: false, value: null })
  })

  describe('answers { valid: false } without rejecting', () => {
    const signer = new HMACCookieSigner({ secret: SECRET })
    const invalid = { valid: false, renew: false, value: null }

    const cases: Array<[string, (signed: string) => string]> = [
      ['a value changed under its signature', signed => `x${signed}`],
      ['a signature changed', signed => withSignature(signed, `A${signatureOf(signed).slice(1)}`)],
      ['a signature one character short', signed => signed.slice(0, -1)],
      ['a signature one character long', signed => `${signed}A`],
      ['a signature with its padding', signed => `${signed}=`],
      ['a signature in base64url', signed => withSignature(signed, signatureOf(signed).replace(/[+/]/g, '-') + '_')],
      ['a signature with whitespace', signed => withSignature(signed, ` ${signatureOf(signed).slice(1)}`)],
      ['no signature at all', () => 'value'],
      ['an empty string', () => ''],
      // The last character carries two bits no byte uses: setting one spells the same signature differently.
      [
        'a signature whose unused bits are set',
        signed => {
          const signature = signatureOf(signed)
          const last = BASE64[BASE64.indexOf(signature.at(-1)!) ^ 1]!
          return withSignature(signed, signature.slice(0, -1) + last)
        },
      ],
    ]

    for (const [what, tamper] of cases) {
      it(`for ${what}`, async () => {
        await expect(signer.unsign(tamper(await signer.sign('value')))).resolves.toEqual(invalid)
      })
    }

    it('for a signature another algorithm made', async () => {
      const longer = await new HMACCookieSigner({ secret: SECRET, algorithm: 'SHA-512' }).sign('value')

      await expect(signer.unsign(longer)).resolves.toEqual(invalid)
    })
  })

  describe('a secret handed to the call', () => {
    it('signs and verifies in place of the configured one', async () => {
      const signer = new HMACCookieSigner({ secret: SECRET })
      const signed = await signer.sign('v', OTHER)

      expect(signed).toBe(fastifySign('v', OTHER))
      expect(await signer.unsign(signed, OTHER)).toEqual({ valid: true, renew: false, value: 'v' })
      expect(await signer.unsign(signed)).toEqual({ valid: false, renew: false, value: null })
    })

    it('rotates as the configured ones do', async () => {
      const signer = new HMACCookieSigner()

      expect(await signer.unsign(fastifySign('v', OLDER), [OTHER, OLDER])).toEqual({
        valid: true,
        renew: true,
        value: 'v',
      })
    })

    // The signer is built once, as the server starts; a secret a call brings is imported once too, not per request.
    it('has its key imported once', async () => {
      const signer = new HMACCookieSigner()
      const importKey = vi.spyOn(crypto.subtle, 'importKey')

      await signer.sign('a', OTHER)
      await signer.sign('b', OTHER)
      await signer.unsign(await signer.sign('c', OTHER), OTHER)

      expect(importKey).toHaveBeenCalledTimes(1)
    })

    it('keeps the keys of a bounded number of secrets', async () => {
      const signer = new HMACCookieSigner()
      const secrets = Array.from({ length: 65 }, (_, i) => `${OTHER}-${i}`)
      const importKey = vi.spyOn(crypto.subtle, 'importKey')

      for (const secret of secrets) {
        await signer.sign('v', secret)
      }
      await signer.sign('v', secrets[64])
      expect(importKey).toHaveBeenCalledTimes(65)

      // The first was let go to make room for the last.
      await signer.sign('v', secrets[0])
      expect(importKey).toHaveBeenCalledTimes(66)
    })

    it('is held to the same floor', async () => {
      await expect(new HMACCookieSigner().sign('v', 'short')).rejects.toBeInstanceOf(ErrCookieConfiguration)
    })
  })

  it('refuses to sign without a secret, configured or handed to the call', async () => {
    await expect(new HMACCookieSigner().sign('v')).rejects.toMatchObject({
      name: 'ErrCookieConfiguration',
      message: expect.stringContaining('no secret is configured'),
    })
  })

  describe('refuses a configuration', () => {
    it.each([
      [
        'a short secret',
        { secret: 'x'.repeat(MIN_COOKIE_SECRET_LENGTH - 1) },
        'the secret must be at least 32 characters',
      ],
      ['a short secret in a list', { secret: [SECRET, 'too-short-a-secret'] }, 'secret 1 of the list must be'],
      ['an empty list', { secret: [] }, 'the list of secrets is empty'],
      ['an unsupported algorithm', { algorithm: 'SHA-1' as CookieSigningAlgorithm }, 'unsupported algorithm "SHA-1"'],
    ])('with %s', (_what, options, message) => {
      expect(() => new HMACCookieSigner(options)).toThrow(ErrCookieConfiguration)
      expect(() => new HMACCookieSigner(options)).toThrow(message)
    })

    // The message is read in logs and, with stack traces exposed, by clients.
    it('without repeating the secret', () => {
      const secret = 'a-secret-that-is-too-short'

      expect(() => new HMACCookieSigner({ secret })).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining(secret) }),
      )
    })

    it('accepting a secret of exactly the floor', () => {
      expect(() => new HMACCookieSigner({ secret: 'x'.repeat(MIN_COOKIE_SECRET_LENGTH) })).not.toThrow()
    })
  })
})
