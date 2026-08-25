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
  /**
   * `sha256` of the token this series held before the most recent rotation, base64url.
   *
   * Rotation is single-use, so presenting a superseded token normally means the token was stolen and the
   * whole series is revoked. But a browser issues requests in parallel — a document and the assets it
   * references — and every one of them carries the cookie as it was when the batch started. Without this,
   * the first response to rotate turns each of its siblings into an apparent theft and signs the user out.
   *
   * So a superseded token is accepted, without rotating again, while it is still within the grace window
   * (see {@link RememberMeRecord.rotatedAt}). Anything older than the window is theft and is treated as
   * such. Absent on a freshly created series, which has nothing to supersede.
   */
  previousTokenHash?: string
  /** When {@link RememberMeRecord.previousTokenHash} was superseded, epoch seconds. */
  rotatedAt?: number
}

/** The state a rotation writes. Grouped rather than positional: four bare arguments invite transposition. */
export interface RememberMeRotation {
  /** `sha256` of the newly minted token. */
  tokenHash: string
  /** `sha256` of the token being superseded — the record's `tokenHash` before this call. */
  previousTokenHash: string
  /** When this rotation happened, epoch seconds. */
  rotatedAt: number
  /** The extended absolute expiry, epoch seconds. */
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

  /**
   * Rotate the token hash for an existing series, extending its expiry.
   *
   * Persist every field of {@link RememberMeRotation}: `previousTokenHash` and `rotatedAt` are what let
   * the guard tell a parallel in-flight request apart from a replayed stolen token, and dropping them
   * turns ordinary concurrent traffic into forced sign-outs.
   */
  abstract updateToken(series: string, rotation: RememberMeRotation): Promise<void> | void

  /** Revoke a single remember credential (sign-out, or a detected token theft). */
  abstract remove(series: string): Promise<void> | void

  /** Revoke every remember credential a user holds — "log out / forget me everywhere". */
  abstract removeBySubject(subject: string): Promise<void> | void
}
