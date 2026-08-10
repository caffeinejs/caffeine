/**
 * A durable refresh credential held server-side, addressed by an opaque `series`.
 *
 * The `token` is never stored — only its hash — so a store leak does not hand out working refresh
 * tokens. `subject` (the user's `sub`) is the index for revoking every refresh credential a user holds.
 */
export interface RefreshTokenRecord {
  /** Opaque lookup key for this refresh credential. */
  series: string
  /** The user's `sub`; index for {@link RefreshTokenStore.removeBySubject}. */
  subject: string
  /** `sha256` of the current token, base64url. Rotated on every refresh. */
  tokenHash: string
  /** Absolute expiry, epoch seconds. */
  expiresAt: number
}

/**
 * Persists durable refresh tokens for the bearer refresh-token grant so they survive access-token
 * expiry and can be revoked server-side.
 *
 * Abstract class rather than an interface so it is a runtime value: it doubles as the DI token and the
 * base class. Extend it and bind the concrete type (`bind(DbRefreshStore).toSelf().extends()`), like
 * `OpaqueTokenStore` / `UserProvider` / `RememberMeTokenStore`.
 *
 * No production implementation ships with this package, deliberately: an in-process store is a footgun
 * once there is more than one instance. Supply one backed by whatever the deployment already shares
 * (Redis, a database); `removeBySubject` needs a secondary index keyed by subject.
 */
export abstract class RefreshTokenStore {
  /** Persist a freshly-minted series. */
  abstract create(record: RefreshTokenRecord): Promise<void> | void

  /** Look a series up. Return null for unknown, expired, or revoked series. */
  abstract findBySeries(series: string): Promise<RefreshTokenRecord | null> | RefreshTokenRecord | null

  /** Rotate the token hash (and extend expiry) for an existing series. */
  abstract updateToken(series: string, tokenHash: string, expiresAt: number): Promise<void> | void

  /** Revoke a single refresh credential (sign-out, or a detected token theft). */
  abstract remove(series: string): Promise<void> | void

  /** Revoke every refresh credential a user holds — "log out everywhere". */
  abstract removeBySubject(subject: string): Promise<void> | void
}
