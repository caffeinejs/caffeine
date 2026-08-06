/**
 * A durable remember-me credential held server-side, addressed by an opaque `series`.
 *
 * The `token` is never stored — only its hash — so the store leaking does not hand out working
 * credentials. `subject` (the user's `sub`) is the index for revoking every remember credential a user
 * holds.
 */
export interface RememberMeRecord {
  /** Opaque lookup key for this remember credential. */
  series: string
  /** The user's `sub` claim; index for {@link RememberMeTokenStore.removeBySubject}. */
  subject: string
  /** `sha256` of the current token, base64url. Rotated on every use. */
  tokenHash: string
  /** Absolute expiry, epoch seconds. */
  expiresAt: number
}

/**
 * Persists durable remember-me credentials so they survive session expiry and can be revoked
 * server-side.
 *
 * Abstract class rather than an interface so it is a runtime value: it doubles as the DI token and the
 * base class. Extend it and bind the concrete type (`bind(DbRememberStore).toSelf().extends()`), like
 * `OpaqueTokenStore` / `UserProvider`.
 *
 * No production implementation ships with this package, deliberately: an in-process store is a footgun
 * once there is more than one instance. Supply one backed by whatever the deployment already shares
 * (Redis, a database); `removeBySubject` needs a secondary index keyed by subject.
 */
export abstract class RememberMeTokenStore {
  /** Persist a freshly-minted series. */
  abstract create(record: RememberMeRecord): Promise<void> | void

  /** Look a series up. Return null for unknown, expired, or revoked series. */
  abstract findBySeries(series: string): Promise<RememberMeRecord | null> | RememberMeRecord | null

  /** Rotate the token hash (and extend expiry) for an existing series. */
  abstract updateToken(series: string, tokenHash: string, expiresAt: number): Promise<void> | void

  /** Revoke a single remember credential (sign-out, or a detected token theft). */
  abstract remove(series: string): Promise<void> | void

  /** Revoke every remember credential a user holds — "log out / forget me everywhere". */
  abstract removeBySubject(subject: string): Promise<void> | void
}
