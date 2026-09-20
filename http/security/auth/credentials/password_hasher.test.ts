import * as crypto from 'node:crypto'

import { afterEach, describe, it, expect, vi } from 'vitest'

import { ScryptPasswordHasher } from './password_hasher.js'

// The real `scrypt`, watched: what matters below is whether a derivation was made, and with which parameters.
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof crypto>()
  return { ...actual, scrypt: vi.fn(actual.scrypt) }
})

// Small cost parameters keep the suite fast; production defaults are far higher.
const hasher = new ScryptPasswordHasher({ N: 1024 })

const derivations = () =>
  (vi.mocked(crypto.scrypt).mock.calls as unknown as Array<[string, Buffer, number, crypto.ScryptOptions]>).map(
    ([, , , options]) => options,
  )

afterEach(() => vi.mocked(crypto.scrypt).mockClear())

describe('ScryptPasswordHasher', () => {
  it('produces a PHC-style encoded string, never the plaintext', async () => {
    const encoded = await hasher.hash('hunter2')
    expect(encoded).not.toContain('hunter2')
    expect(encoded).toMatch(/^\$scrypt\$n=1024,r=8,p=3\$[^$]+\$[^$]+$/)
  })

  // One of the configurations OWASP lists as equivalent to its scrypt minimum of N=2^17, r=8, p=1.
  it('hashes with N=2^15, r=8, p=3 unless told otherwise', async () => {
    expect(await new ScryptPasswordHasher().hash('x')).toMatch(/^\$scrypt\$n=32768,r=8,p=3\$/)
  })

  it('salts, so two hashes of the same password differ', async () => {
    const a = await hasher.hash('same')
    const b = await hasher.hash('same')
    expect(a).not.toBe(b)
  })

  it('verifies the correct password', async () => {
    const encoded = await hasher.hash('correct horse')
    expect(await hasher.verify('correct horse', encoded)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const encoded = await hasher.hash('correct horse')
    expect(await hasher.verify('wrong horse', encoded)).toBe(false)
  })

  it('returns false for a malformed encoded hash instead of throwing', async () => {
    expect(await hasher.verify('x', 'not-a-phc-string')).toBe(false)
    expect(await hasher.verify('x', '$scrypt$bad$params$here')).toBe(false)
    expect(await hasher.verify('x', '')).toBe(false)
  })

  it('needsRehash is false for a hash made with the current params', async () => {
    const encoded = await hasher.hash('x')
    expect(hasher.needsRehash(encoded)).toBe(false)
  })

  it('needsRehash is true for a hash made with weaker params', async () => {
    const weak = await new ScryptPasswordHasher({ N: 512 }).hash('x')
    expect(hasher.needsRehash(weak)).toBe(true)
  })

  it('needsRehash is true for a malformed hash', () => {
    expect(hasher.needsRehash('garbage')).toBe(true)
  })

  // The hashes made before the default changed: they still verify, and are upgraded at the next sign-in.
  it('still verifies a hash made with p=1, and asks for it to be rehashed', async () => {
    const old = await new ScryptPasswordHasher({ N: 1024, p: 1 }).hash('x')

    expect(await hasher.verify('x', old)).toBe(true)
    expect(hasher.needsRehash(old)).toBe(true)
  })

  // An account that only signs in through a provider has no password hash. Refused at once, it is told apart from
  // every other account by a stopwatch.
  it.each(['', 'not-a-phc-string', '$scrypt$bad$params$here'])(
    'does the work of a verification before refusing the unreadable hash "%s"',
    async encoded => {
      expect(await hasher.verify('x', encoded)).toBe(false)

      expect(derivations()).toEqual([expect.objectContaining({ N: 1024, r: 8, p: 3 })])
    },
  )

  // The parameters are read back from storage. Whoever can write there must not be able to make one sign-in attempt
  // allocate a gigabyte, so such a hash is unreadable, and is refused with this hasher's own parameters.
  it.each([
    ['memory', '$scrypt$n=1073741824,r=8,p=1$c2FsdHNhbHQ=$aGFzaGhhc2g='],
    ['block size', '$scrypt$n=1024,r=1048576,p=1$c2FsdHNhbHQ=$aGFzaGhhc2g='],
    ['parallelization', '$scrypt$n=1024,r=8,p=4096$c2FsdHNhbHQ=$aGFzaGhhc2g='],
    ['nothing at all', '$scrypt$n=0,r=0,p=0$c2FsdHNhbHQ=$aGFzaGhhc2g='],
    ['key length', `$scrypt$n=1024,r=8,p=1$c2FsdHNhbHQ=$${Buffer.alloc(4096).toString('base64')}`],
  ])('never derives with a stored hash that asks for %s out of proportion', async (_, encoded) => {
    expect(await hasher.verify('x', encoded)).toBe(false)

    expect(derivations()).toEqual([expect.objectContaining({ N: 1024, r: 8, p: 3 })])
    expect(hasher.needsRehash(encoded)).toBe(true)
  })
})
