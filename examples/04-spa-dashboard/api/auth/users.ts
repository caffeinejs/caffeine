import { Injectable } from '@caffeinejs/di'
import { Claim, PasswordHasher, UserProvider, type CredentialUser } from '@caffeinejs/http'

/** What the demo signs in with. A real application looks these up in a database. */
const ACCOUNTS = [
  { id: 'admin', name: 'Ada Admin', password: 'admin123', roles: ['admin', 'member'] },
  { id: 'user', name: 'Ulric User', password: 'user123', roles: ['member'] },
] as const

/**
 * The two hardcoded accounts, as the `UserProvider` the credential flow resolves.
 *
 * `@Injectable` registers a class under its own key *and* its superclass's, so listing this in the generated
 * module is all it takes for `CredentialsService` to find it — there is no `container.bind(UserProvider, …)`
 * anywhere in this example.
 *
 * Passwords are hashed once, on first use, with the `PasswordHasher` the authentication builder bound
 * (`ScryptPasswordHasher` unless the application bound its own). Hashing rather than comparing the plaintext
 * is the point: `CredentialsService.attempt` then runs the same work for a name that does not exist as for
 * one that does, so the response time does not say which accounts are real.
 */
@Injectable([PasswordHasher])
export class Users extends UserProvider {
  readonly #hasher: PasswordHasher
  #users: Promise<Map<string, CredentialUser>> | undefined

  constructor(hasher: PasswordHasher) {
    super()
    this.#hasher = hasher
  }

  async findByIdentifier(identifier: string): Promise<CredentialUser | null> {
    return (await this.#load()).get(identifier.toLowerCase()) ?? null
  }

  override async findById(id: string): Promise<CredentialUser | null> {
    return this.findByIdentifier(id)
  }

  /** Every account, for the administration endpoint. Never includes the hashes. */
  static directory(): Array<{ id: string; name: string; roles: string[] }> {
    return ACCOUNTS.map(({ id, name, roles }) => ({ id, name, roles: [...roles] }))
  }

  #load(): Promise<Map<string, CredentialUser>> {
    // Cached as the promise, not the result: two concurrent sign-ins must not each pay for the hashing.
    this.#users ??= (async () => {
      const entries = await Promise.all(
        ACCOUNTS.map(async account => {
          const user: CredentialUser = {
            id: account.id,
            passwordHash: await this.#hasher.hash(account.password),
            claims: [
              new Claim('name', account.name, ''),
              // `roles` is the cookie scheme's `roleClaimType`, so `authorize({ roles: [...] })` reads these.
              ...account.roles.map(role => new Claim('roles', role, '')),
            ],
          }

          return [account.id, user] as const
        }),
      )

      return new Map(entries)
    })()

    return this.#users
  }
}
