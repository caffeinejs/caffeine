import type { RemoteAuthenticationSession } from './session_store.js'
import type { RemoteAuthenticationTokens } from './handler.js'

/**
 * A session held server-side, addressed by an opaque key carried in the cookie.
 */
export interface RemoteAuthenticationTicket {
  session: RemoteAuthenticationSession
  /** The `sub` claim. The index for revoking every session belonging to one user. */
  subject: string

  /**
   * The provider's tokens, when the strategy is configured to keep them.
   *
   * Server-side only, and only ever here — refresh tokens are the longest-lived credential in
   * the system and the session cookie is client-side and size-capped. This is why `saveTokens`
   * requires a ticket store rather than falling back to the cookie.
   */
  tokens?: RemoteAuthenticationTokens
}

/**
 * Holds sessions server-side so they can be revoked before their TTL expires.
 *
 * Without one the sealed cookie *is* the session: the server keeps no record of it, so signing
 * out clears the cookie from the responding browser and nothing more — any copy of that cookie
 * stays valid until `exp`.
 *
 * No production implementation ships with this package, deliberately. An in-process store is a
 * footgun once there is more than one instance: sessions break on the wrong node and
 * `removeBySubject` revokes only where it was called. Supply one
 * backed by whatever the deployment already shares — Redis, a database. `TestOAuthTicketStore`
 * in `@caffeinejs/testing` covers tests.
 */
export interface RemoteAuthenticationTicketStore {
  /**
   * Persists a ticket under a key the handler generated.
   *
   * Implementations must not derive or replace the key. It is a bearer credential and its
   * entropy is the session's security; the handler mints it from `randomBytes(32)`.
   */
  store(key: string, ticket: RemoteAuthenticationTicket, ttlSeconds: number): Promise<void>

  /** Returns undefined for an unknown, expired, or revoked key. */
  retrieve(key: string): Promise<RemoteAuthenticationTicket | undefined>

  remove(key: string): Promise<void>

  /**
   * Revokes every session belonging to one user — sign-out-everywhere, and erasure requests.
   *
   * Implementations need a secondary index keyed by subject, not just a keyspace: a Redis
   * store needs a SET per subject alongside the ticket keys.
   */
  removeBySubject(subject: string): Promise<void>
}
