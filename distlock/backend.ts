import type { Duration } from '@caffeinejs/std/duration'

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
 *
 * The lock service bounds every call with `storeTimeout` and hands it a signal that aborts at that deadline or
 * when the caller gives up. A backend may ignore the signal. One that honours it rejects with `signal.reason`
 * only while the operation has not taken effect and will not; once a write may have landed, it resolves with
 * what it got. Either way the service stops waiting at the deadline and releases any lease a call returns after
 * it. The service cannot see a client's own timeouts, so bound the client too: an abandoned call keeps its
 * connection until the client gives up.
 */
export interface Backend {
  /** One attempt, no waiting: the lease, or `undefined` when the key is already held. */
  tryAcquire(key: string, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined>

  /**
   * Sets the key's validity to `ttl` from now, only while its token still matches. `undefined` means the
   * lease was lost.
   *
   * It is compare-and-expire, never a write that could put the key back: a key that lapsed or was released
   * stays gone, and this reports the loss instead. A renewal can be in flight when its holder releases, and
   * one that recreated the key would leave it taken for a whole further lease with nobody holding it.
   *
   * A smaller `ttl` than the lease has left shortens it — this sets the validity rather than adding to it.
   *
   * The returned lease supersedes the one passed in. A backend may rotate the token here; the holder carries
   * the new one from then on, release included.
   */
  extend(lease: LockLease, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined>

  /** Releases the key only while the lease's token still matches. */
  release(lease: LockLease, signal?: AbortSignal): Promise<void>
}
