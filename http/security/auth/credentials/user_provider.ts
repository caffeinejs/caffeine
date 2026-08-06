import type { Claim } from '../../index.js'

/**
 * A user record resolved by a {@link UserProvider}, carrying just what credential verification needs:
 * a stable id, the stored password hash, and any extra claims (roles, email, …) to place on the
 * resulting principal. Persistence-only — no verification logic lives here.
 */
export interface CredentialUser {
  id: string
  passwordHash: string
  claims?: Claim[]
}

/**
 * Looks a user up by a login identifier (email, username, …) for the credential flow.
 *
 * Abstract class rather than an interface so it is a runtime value: it doubles as the DI token and the
 * base class. Extend it and bind the concrete type to the `UserProvider` token
 * (`bind(DbUserProvider).toSelf().extends()`), exactly like `OpaqueTokenStore`. The provider only
 * *finds*; `CredentialsService` runs the password verification.
 */
export abstract class UserProvider {
  abstract findByIdentifier(identifier: string): Promise<CredentialUser | null> | CredentialUser | null

  /**
   * Look a user up by id (the `sub` claim) rather than a login identifier.
   *
   * Only used by durable cookie remember-me, which reloads the user to rebuild a fresh session after
   * the session cookie expires. Throws by default so credential-only providers need not implement it;
   * override it when enabling durable remember-me.
   */
  findById(_id: string): Promise<CredentialUser | null> | CredentialUser | null {
    throw new Error('UserProvider.findById must be implemented to use durable remember-me')
  }
}
