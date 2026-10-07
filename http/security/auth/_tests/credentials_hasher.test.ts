import { $cond, CaffeineIoC, mod } from '@caffeinejs/di'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type CredentialUser,
  PasswordHasher,
  ScryptPasswordHasher,
  UserProvider,
  createWebApplication,
  Authentication,
  authentication,
} from '../../../index.js'

const JWT_SECRET = 'a-jwt-secret-that-is-at-least-32-bytes!!'

class Users extends UserProvider {
  findByIdentifier(): CredentialUser | null {
    return null
  }
}

function credentialsApp(container: CaffeineIoC) {
  container.bind(UserProvider, t => t.toValue(new Users()))

  return createWebApplication({ container })
    .install(
      Authentication(a => a.addJWTBearer(b => b.secret(JWT_SECRET).issuer('local').audience('local')).addCredentials()),
    )
    .with(authentication())
}

// The application's own hasher has to win however it reaches the container. A lost one goes unnoticed at sign-in:
// the scrypt parameters travel inside each stored hash, so the default still verifies every password.
describe('the PasswordHasher addCredentials() provides', () => {
  it('is ScryptPasswordHasher when the application binds none', async () => {
    const app = credentialsApp(new CaffeineIoC())
    await app.bootstrap()

    expect(app.container.get(PasswordHasher)).toBeInstanceOf(ScryptPasswordHasher)

    await app.close()
  })

  it('is the one the application bound before bootstrap()', async () => {
    const own = new ScryptPasswordHasher({ N: 1024 })
    const container = new CaffeineIoC()
    container.bind(PasswordHasher, t => t.toValue(own))

    const app = credentialsApp(container)
    await app.bootstrap()

    expect(app.container.get(PasswordHasher)).toBe(own)

    await app.close()
  })

  it('is the one a module bound after the feature configured', async () => {
    const own = new ScryptPasswordHasher({ N: 1024 })
    const container = new CaffeineIoC({
      modules: [mod('hasher', c => c.bind(PasswordHasher, t => t.toValue(own)))],
    })

    const app = credentialsApp(container)
    await app.bootstrap()

    expect(app.container.get(PasswordHasher)).toBe(own)

    await app.close()
  })

  // The feature's default is decided after every binding answering to PasswordHasher, so one that is itself
  // conditional, and decided after the default would have been, still wins.
  describe('bound with a condition', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('is the one a module bound when its condition passes', async () => {
      vi.stubEnv('CAFFEINE_TEST_OWN_HASHER', 'on')
      const own = new ScryptPasswordHasher({ N: 1024 })
      const container = new CaffeineIoC({
        modules: [
          mod('hasher', c =>
            c.bind(PasswordHasher, t => t.toValue(own).conditional($cond.env('CAFFEINE_TEST_OWN_HASHER'))),
          ),
        ],
      })

      const app = credentialsApp(container)
      await app.bootstrap()

      expect(app.container.get(PasswordHasher)).toBe(own)

      await app.close()
    })

    it('is ScryptPasswordHasher when the condition fails', async () => {
      vi.stubEnv('CAFFEINE_TEST_OWN_HASHER', undefined)
      const own = new ScryptPasswordHasher({ N: 1024 })
      const container = new CaffeineIoC({
        modules: [
          mod('hasher', c =>
            c.bind(PasswordHasher, t => t.toValue(own).conditional($cond.env('CAFFEINE_TEST_OWN_HASHER'))),
          ),
        ],
      })

      const app = credentialsApp(container)
      await app.bootstrap()

      expect(app.container.get(PasswordHasher)).not.toBe(own)
      expect(app.container.get(PasswordHasher)).toBeInstanceOf(ScryptPasswordHasher)

      await app.close()
    })
  })
})
