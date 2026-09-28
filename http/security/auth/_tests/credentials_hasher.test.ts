import { CaffeineIoC, mod } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import {
  type CredentialUser,
  PasswordHasher,
  ScryptPasswordHasher,
  UserProvider,
  createWebApplication,
} from '../../../index.js'

const JWT_SECRET = 'a-jwt-secret-that-is-at-least-32-bytes!!'

class Users extends UserProvider {
  findByIdentifier(): CredentialUser | null {
    return null
  }
}

function credentialsApp(container: CaffeineIoC) {
  container.bind(UserProvider, t => t.toValue(new Users()))

  return createWebApplication({ container }).authentication(a =>
    a.addJWTBearer(b => b.secret(JWT_SECRET).issuer('local').audience('local')).addCredentials(),
  )
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

  // The module's hasher is conditional and is decided after the default the feature bound, so the default must wait for
  // it rather than register beside it and leave PasswordHasher with two candidates.
  it('is the one a module binds conditionally under its own key', async () => {
    class OwnHasher extends ScryptPasswordHasher {}

    const container = new CaffeineIoC({
      modules: [
        mod('hasher', c =>
          c.bind(OwnHasher, t =>
            t
              .toSelf()
              .extends(PasswordHasher)
              .conditional(cond => cond.when(() => true)),
          ),
        ),
      ],
    })

    const app = credentialsApp(container)
    await app.bootstrap()

    expect(app.container.get(PasswordHasher)).toBeInstanceOf(OwnHasher)

    await app.close()
  })
})
