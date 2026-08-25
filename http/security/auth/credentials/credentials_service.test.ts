import { describe, it, expect, vi } from 'vitest'
import { Claim } from '../../index.js'
import { CredentialsService } from './credentials_service.js'
import type { PasswordHasher } from './password_hasher.js'
import { ScryptPasswordHasher } from './password_hasher.js'
import type { CredentialUser, UserProvider } from './user_provider.js'

const hasher = new ScryptPasswordHasher({ N: 1024 })

function providerFor(user: CredentialUser | null): UserProvider {
  return { findByIdentifier: vi.fn().mockResolvedValue(user), findById: vi.fn() }
}

describe('CredentialsService', () => {
  it('returns a principal with sub + extra claims on a correct password', async () => {
    const passwordHash = await hasher.hash('secret')
    const provider = providerFor({ id: 'u1', passwordHash, claims: [new Claim('roles', 'admin', '')] })
    const svc = new CredentialsService(provider, hasher)

    const principal = await svc.attempt('alice', 'secret')
    expect(principal).not.toBeNull()
    expect(principal!.authenticated).toBe(true)
    expect(principal!.findFirst('sub')?.value).toBe('u1')
    expect(principal!.isInRole('admin')).toBe(true)
  })

  it('returns null on a wrong password', async () => {
    const passwordHash = await hasher.hash('secret')
    const svc = new CredentialsService(providerFor({ id: 'u1', passwordHash }), hasher)
    expect(await svc.attempt('alice', 'nope')).toBeNull()
  })

  it('returns null for an unknown user AND still runs a decoy verify (timing equalization)', async () => {
    const spyHasher = {
      hash: vi.fn().mockResolvedValue('$decoy$'),
      verify: vi.fn().mockResolvedValue(false),
      needsRehash: vi.fn().mockReturnValue(false),
    } as unknown as PasswordHasher

    const svc = new CredentialsService(providerFor(null), spyHasher)
    expect(await svc.attempt('ghost', 'whatever')).toBeNull()

    // Unknown user must not short-circuit before hashing work: a decoy is hashed then verified.
    expect(spyHasher.hash).toHaveBeenCalledOnce()
    expect(spyHasher.verify).toHaveBeenCalledWith('whatever', '$decoy$')
  })

  it('honours a custom identity scheme name', async () => {
    const passwordHash = await hasher.hash('secret')
    const svc = new CredentialsService(providerFor({ id: 'u1', passwordHash }), hasher, { scheme: 'Password' })
    const principal = await svc.attempt('alice', 'secret')
    expect(principal!.identities[0].authenticationType).toBe('Password')
  })

  it('verifyCredentials is an alias of attempt', async () => {
    const passwordHash = await hasher.hash('secret')
    const svc = new CredentialsService(providerFor({ id: 'u1', passwordHash }), hasher)
    expect(await svc.verifyCredentials('alice', 'secret')).not.toBeNull()
    expect(await svc.verifyCredentials('alice', 'bad')).toBeNull()
  })

  // Login is the only moment the plaintext is in hand, so it is the only moment a stored hash can be
  // upgraded. Without this, raising the scrypt cost left every existing user on the old parameters.
  describe('attemptWithRehash', () => {
    it('flags a hash produced with weaker parameters than the current hasher', async () => {
      const weak = new ScryptPasswordHasher({ N: 1024 })
      const strong = new ScryptPasswordHasher({ N: 4096 })
      const passwordHash = await weak.hash('secret')
      const svc = new CredentialsService(providerFor({ id: 'u1', passwordHash }), strong)

      const result = await svc.attemptWithRehash('alice', 'secret')

      expect(result).not.toBeNull()
      expect(result!.needsRehash).toBe(true)
      expect(result!.userID).toBe('u1')
    })

    it('does not flag a hash already at the current parameters', async () => {
      const passwordHash = await hasher.hash('secret')
      const svc = new CredentialsService(providerFor({ id: 'u1', passwordHash }), hasher)

      expect((await svc.attemptWithRehash('alice', 'secret'))!.needsRehash).toBe(false)
    })

    it('returns null for a bad password, with nothing to rehash', async () => {
      const passwordHash = await hasher.hash('secret')
      const svc = new CredentialsService(providerFor({ id: 'u1', passwordHash }), hasher)

      expect(await svc.attemptWithRehash('alice', 'wrong')).toBeNull()
    })
  })
})
