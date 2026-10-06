import { afterEach, describe, expect, it, vi } from 'vitest'

import { openJWT, sealJWT, unsealJWT } from './sealed_jwt.js'

const SECRET = 'test-session-secret-at-least-32-chars!!'
const TYP = 'session+jwt'
const INFO = 'caffeine:test:session+jwt:Cookie'

const b64u = (value: string | Uint8Array): string => Buffer.from(value).toString('base64url')

/** A compact JWE that says `header` about itself. Nothing in it is a real ciphertext: no key was used to make it. */
function forged(header: Record<string, unknown>): string {
  const encryptedKey = header.alg === 'dir' ? '' : b64u(new Uint8Array(40))

  return [
    b64u(JSON.stringify(header)),
    encryptedKey,
    b64u(new Uint8Array(12)),
    b64u(new Uint8Array(16)),
    b64u(new Uint8Array(16)),
  ].join('.')
}

describe('sealed tokens', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens what it sealed', async () => {
    const token = await sealJWT({ sub: 'ada' }, TYP, SECRET, INFO, 60)

    await expect(unsealJWT(token, TYP, SECRET, INFO)).resolves.toMatchObject({ sub: 'ada' })
  })

  // A secret read from a key file arrives as bytes. The key is derived from the bytes either way, so moving a
  // deployment's secret from a variable to a file does not sign every user out.
  it('seals under a secret given as bytes, and opens it under the same secret given as text', async () => {
    const bytes = new TextEncoder().encode(SECRET)
    const token = await sealJWT({ sub: 'ada' }, TYP, bytes, INFO, 60)

    await expect(unsealJWT(token, TYP, bytes, INFO)).resolves.toMatchObject({ sub: 'ada' })
    await expect(unsealJWT(token, TYP, SECRET, INFO)).resolves.toMatchObject({ sub: 'ada' })
  })

  it('does not open under another secret', async () => {
    const token = await sealJWT({ sub: 'ada' }, TYP, SECRET, INFO, 60)

    await expect(unsealJWT(token, TYP, 'another-session-secret-at-least-32-chars', INFO)).rejects.toMatchObject({
      code: 'ERR_JWE_DECRYPTION_FAILED',
    })
  })

  // Two schemes usually share one secret, since it comes from one environment variable. The derivation label is
  // what keeps a session sealed by one of them from being a session at the other.
  it('does not open under another derivation label, the secret being the same', async () => {
    const token = await sealJWT({ sub: 'ada' }, TYP, SECRET, INFO, 60)

    await expect(unsealJWT(token, TYP, SECRET, 'caffeine:test:session+jwt:Other')).rejects.toMatchObject({
      code: 'ERR_JWE_DECRYPTION_FAILED',
    })
  })

  // The type is checked by itself: a token that opens under the right key is still refused when it was sealed for
  // another purpose, so a state token can never stand in for a session.
  it('refuses a token sealed for another purpose, the key being the same', async () => {
    const token = await sealJWT({ sub: 'ada' }, 'state+jwt', SECRET, INFO, 60)

    await expect(unsealJWT(token, TYP, SECRET, INFO)).rejects.toMatchObject({
      code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
      claim: 'typ',
    })
  })

  it('refuses a token with one byte of its ciphertext changed', async () => {
    const segments = (await sealJWT({ sub: 'ada', roles: ['user'] }, TYP, SECRET, INFO, 60)).split('.')
    const ciphertext = Buffer.from(segments[3], 'base64url')
    ciphertext[0] ^= 0x01
    segments[3] = ciphertext.toString('base64url')

    await expect(unsealJWT(segments.join('.'), TYP, SECRET, INFO)).rejects.toMatchObject({
      code: 'ERR_JWE_DECRYPTION_FAILED',
    })
  })

  // The cookie's own `Max-Age` is the browser's to honour. The expiry inside the token is the one that holds.
  it('refuses a token past its lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const token = await sealJWT({ sub: 'ada' }, TYP, SECRET, INFO, 60)

    vi.setSystemTime(new Date('2026-01-01T00:00:59Z'))
    await expect(unsealJWT(token, TYP, SECRET, INFO)).resolves.toMatchObject({ sub: 'ada' })

    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
    await expect(unsealJWT(token, TYP, SECRET, INFO)).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' })
  })

  // What a token says about how it was made decides nothing (RFC 8725 §3.1): both algorithms are refused by name,
  // before any key is tried against them.
  it('refuses a token that names another key management algorithm', async () => {
    const token = forged({ alg: 'A256KW', enc: 'A256GCM', typ: TYP })

    await expect(unsealJWT(token, TYP, SECRET, INFO)).rejects.toMatchObject({ code: 'ERR_JOSE_ALG_NOT_ALLOWED' })
  })

  it('refuses a token that names another content encryption algorithm', async () => {
    const token = forged({ alg: 'dir', enc: 'A128CBC-HS256', typ: TYP })

    await expect(unsealJWT(token, TYP, SECRET, INFO)).rejects.toMatchObject({ code: 'ERR_JOSE_ALG_NOT_ALLOWED' })
  })

  // Rotation: the first secret seals, any opens, and `renew` says the token is worth sealing again under the first.
  describe('under a list of secrets', () => {
    const NEWER = 'a-newer-session-secret-at-least-32-chars'

    it('seals with the first and opens with any, saying when an older one did', async () => {
      const sealedOld = await sealJWT({ sub: 'ada' }, TYP, SECRET, INFO, 60)
      const sealedNew = await sealJWT({ sub: 'ada' }, TYP, [NEWER, SECRET], INFO, 60)

      await expect(openJWT(sealedOld, TYP, [NEWER, SECRET], INFO)).resolves.toMatchObject({
        claims: { sub: 'ada' },
        renew: true,
      })
      await expect(openJWT(sealedNew, TYP, [NEWER, SECRET], INFO)).resolves.toMatchObject({ renew: false })
      await expect(unsealJWT(sealedNew, TYP, NEWER, INFO)).resolves.toMatchObject({ sub: 'ada' })
    })

    it('tells when the token expires', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const token = await sealJWT({ sub: 'ada' }, TYP, SECRET, INFO, 60)

      const opened = await openJWT(token, TYP, SECRET, INFO)

      expect(opened.exp).toBe(Date.UTC(2026, 0, 1) / 1000 + 60)
    })

    // Only a key that could not decrypt the token is worth another try. An expired token was decrypted: had the next
    // secret been tried, the error would be its failure to decrypt instead.
    it('tries the next secret only when one fails to decrypt', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const token = await sealJWT({ sub: 'ada' }, TYP, SECRET, INFO, 60)
      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))

      await expect(openJWT(token, TYP, [SECRET, NEWER], INFO)).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' })
      await expect(openJWT(token, TYP, [NEWER, SECRET], INFO)).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' })
    })

    it('fails as the last secret failed when none opens it', async () => {
      const token = await sealJWT({ sub: 'ada' }, TYP, SECRET, INFO, 60)

      await expect(openJWT(token, TYP, [NEWER, 'a-third-secret-at-least-32-characters'], INFO)).rejects.toMatchObject({
        code: 'ERR_JWE_DECRYPTION_FAILED',
      })
    })

    it('refuses an empty list', async () => {
      await expect(sealJWT({}, TYP, [], INFO, 60)).rejects.toThrow('the list of secrets is empty')
    })
  })
})
