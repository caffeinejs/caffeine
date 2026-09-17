/**
 * A lease one holder owns on a key.
 *
 * The token is what makes a release safe: a holder whose lease already lapsed must not be able to unlock the
 * replica that took the key over.
 */
export interface LockLease {
  readonly key: string

  /** Identifies the holder. {@link Backend.extend} and {@link Backend.release} must do nothing unless the stored token still matches. */
  readonly token: string

  /**
   * Epoch milliseconds after which the holder must treat the lease as gone.
   *
   * The backend computes it, not the caller. One that spends real time acquiring — a quorum round across
   * several nodes — subtracts what it spent and its own clock-drift budget, so this is the validity a caller
   * may rely on rather than `now + ttl`.
   *
   * The holder compares it against its own clock, so a backend whose clock runs ahead of the holder's leaves
   * the holder believing a lapsed lease is still good. A backend that stamps this from its own clock should
   * subtract the skew it tolerates.
   */
  readonly expiresAt: number
}

/**
 * The service-provider interface one locking technology implements.
 *
 * It is deliberately single-shot: waiting, retrying, backoff and jitter live in the lock service, so a
 * backend is only ever asked to make one attempt. A single-instance adapter is then `SET key token NX PX ttl`
 * plus a compare-and-delete and a compare-and-expire script; a quorum implementation does its rounds, its
 * minority cleanup and its drift arithmetic inside {@link tryAcquire} and reports the outcome through
 * {@link LockLease.expiresAt}.
 */
export interface Backend {
  /** One attempt, no waiting: the lease, or `undefined` when the key is already held. */
  tryAcquire(key: string, ttlMs: number, signal?: AbortSignal): Promise<LockLease | undefined>

  /**
   * Sets the key's validity to `ttlMs` from now, only while its token still matches. `undefined` means the
   * lease was lost.
   *
   * It is compare-and-expire, never a write that could put the key back: a key that lapsed or was released
   * stays gone, and this reports the loss instead. A renewal can be in flight when its holder releases, and
   * one that recreated the key would leave it taken for a whole further lease with nobody holding it.
   *
   * A smaller `ttlMs` than the lease has left shortens it — this sets the validity rather than adding to it.
   *
   * The returned lease supersedes the one passed in. A backend may rotate the token here; the holder carries
   * the new one from then on, release included.
   */
  extend(lease: LockLease, ttlMs: number): Promise<LockLease | undefined>

  /** Releases the key only while the lease's token still matches. */
  release(lease: LockLease): Promise<void>
}
