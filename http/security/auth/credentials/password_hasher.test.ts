import { describe, it, expect } from 'vitest'

import { ScryptPasswordHasher } from './password_hasher.js'

// Small cost parameters keep the suite fast; production defaults are far higher.
const hasher = new ScryptPasswordHasher({ N: 1024 })

describe('ScryptPasswordHasher', () => {
  it('produces a PHC-style encoded string, never the plaintext', async () => {
    const encoded = await hasher.hash('hunter2')
    expect(encoded).not.toContain('hunter2')
    expect(encoded).toMatch(/^\$scrypt\$n=1024,r=8,p=1\$[^$]+\$[^$]+$/)
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
})
