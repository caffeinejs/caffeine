import { Claim, Identity, Principal } from '../../index.js'
import type { PasswordHasher } from './password_hasher.js'
import type { CredentialUser, UserProvider } from './user_provider.js'

export interface CredentialsServiceOptions {
  /** Authentication type stamped on the resulting identity. Default `'Credentials'`. */
  scheme?: string
  /** Claim type treated as the role claim on the resulting identity. Default `'roles'`. */
  roleClaimType?: string
}

/**
 * Builds the authenticated {@link Principal} for a looked-up user: a `sub` claim from the id plus any
 * extra claims the provider supplied. Shared by {@link CredentialsService.attempt} and the cookie
 * remember-me refresh, so both produce identically-shaped principals.
 */
export function buildCredentialPrincipal(
  user: CredentialUser,
  options: CredentialsServiceOptions = {},
): Principal {
  const claims = [new Claim('sub', user.id, ''), ...(user.claims ?? [])]
  const identity = new Identity(options.scheme ?? 'Credentials', true, claims, options.roleClaimType ?? 'roles')
  return new Principal(true, identity)
}

// Plaintext fed to the decoy hash for the unknown-user timing path. Value is irrelevant — it only has
// to make the hasher do the same work it would for a real user so lookups do not leak which succeeded.
const DECOY_PASSWORD = 'caffeine.credentials.decoy'

/**
 * Verifies username/password credentials and produces a {@link Principal}.
 *
 * {@link UserProvider} looks the user up, this service runs {@link PasswordHasher} verification and
 * builds the principal. A login endpoint calls {@link attempt} and, on success, persists a session
 * via `AuthenticationService.persist` (cookie scheme) or issues a token.
 */
export class CredentialsService {
  readonly #provider: UserProvider
  readonly #hasher: PasswordHasher
  readonly #scheme: string
  readonly #roleClaimType: string

  // Lazily-computed decoy hash reused across unknown-user attempts to equalize timing without hashing
  // a fresh decoy every call. Derived from the bound hasher, so it tracks a custom hasher's cost.
  #decoy: string | undefined

  constructor(provider: UserProvider, hasher: PasswordHasher, options: CredentialsServiceOptions = {}) {
    this.#provider = provider
    this.#hasher = hasher
    this.#scheme = options.scheme ?? 'Credentials'
    this.#roleClaimType = options.roleClaimType ?? 'roles'
  }

  /**
   * Verify credentials. Returns the authenticated {@link Principal}, or `null` when the user is unknown
   * or the password does not match. An unknown user still runs a decoy verification so the response
   * time does not reveal whether the identifier exists.
   */
  async attempt(identifier: string, password: string): Promise<Principal | null> {
    return (await this.attemptWithRehash(identifier, password))?.principal ?? null
  }

  /**
   * {@link attempt}, plus whether the stored hash was produced with weaker parameters than the current
   * hasher's — the moment a password can be transparently upgraded, because it is the only point at which
   * the plaintext is in hand.
   *
   * {@link PasswordHasher} already implements `needsRehash`; nothing called it, so raising the scrypt
   * cost meant either leaving every existing user on the old parameters forever or forcing a reset. A
   * login endpoint acting on this re-hashes and persists:
   *
   * ```ts
   * const result = await creds.attemptWithRehash(email, password)
   * if (result?.needsRehash) {
   *   await users.updatePasswordHash(result.userID, await hasher.hash(password))
   * }
   * ```
   */
  async attemptWithRehash(
    identifier: string,
    password: string,
  ): Promise<{ principal: Principal, userID: string, needsRehash: boolean } | null> {
    const user = await this.#provider.findByIdentifier(identifier)

    if (!user) {
      this.#decoy ??= await this.#hasher.hash(DECOY_PASSWORD)
      await this.#hasher.verify(password, this.#decoy)
      return null
    }

    const ok = await this.#hasher.verify(password, user.passwordHash)
    if (!ok) {
      return null
    }

    return {
      principal: buildCredentialPrincipal(user, { scheme: this.#scheme, roleClaimType: this.#roleClaimType }),
      userID: user.id,
      needsRehash: this.#hasher.needsRehash(user.passwordHash),
    }
  }

  /** Alias of {@link attempt}. */
  verifyCredentials(identifier: string, password: string): Promise<Principal | null> {
    return this.attempt(identifier, password)
  }
}
