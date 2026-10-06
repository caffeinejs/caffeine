import { fc, it } from '@fast-check/vitest'
import { sign as fastifySign } from '@fastify/cookie'
import { describe, expect } from 'vitest'

import { HMACCookieSigner } from './signer.js'

const SECRET = 'a-cookie-secret-of-at-least-32-characters'
const signer = new HMACCookieSigner({ secret: SECRET })

// Values with dots, with any code point, and with lone surrogates, which UTF-8 cannot carry and both sides encode as
// U+FFFD alike.
const value = fc.oneof(
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc.array(fc.constantFrom('.', 'a', '\ud800', '\udfff', '='), { maxLength: 8 }).map(parts => parts.join('')),
)

const encoder = new TextEncoder()
const sameBytes = (a: string, b: string): boolean => encoder.encode(a).join() === encoder.encode(b).join()

describe('HMACCookieSigner (property)', () => {
  it.prop([value])('gives back exactly the value it signed', async v => {
    expect(await signer.unsign(await signer.sign(v))).toEqual({ valid: true, renew: false, value: v })
  })

  it.prop([value])('signs every value as @fastify/cookie does', async v => {
    expect(await signer.sign(v)).toBe(fastifySign(v, SECRET))
  })

  it.prop([value, value])('verifies no other value under a signature', async (signed, other) => {
    fc.pre(!sameBytes(signed, other))

    const signature = (await signer.sign(signed)).slice(signed.length + 1)

    expect((await signer.unsign(`${other}.${signature}`)).valid).toBe(false)
  })
})
