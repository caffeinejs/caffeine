import type { Duration } from '@caffeinejs/std/duration'

import type { DistLock } from '../distlock.js'

/**
 * The `node:diagnostics_channel` names the lock service publishes on.
 *
 * `acquire`, `withLock`, `once`, `extend` and `release` are tracing channels: subscribe with
 * `tracingChannel(name)` and each call publishes `start`, `end`, `asyncStart` and `asyncEnd` around one context
 * object, with `error` before `asyncEnd` when the call rejects. `asyncEnd` is the one sub-event every call
 * reaches, and by then the context carries its outcome. `tryWithLock` publishes on `withLock`. `contended`,
 * `lost` and `election` are plain channels.
 *
 * Channels are process-wide, so every context names the lock service that published it in `service`.
 */
export const DIST_LOCK_CHANNELS = {
  acquire: 'caffeinejs:distlock:acquire',
  withLock: 'caffeinejs:distlock:with-lock',
  once: 'caffeinejs:distlock:once',
  extend: 'caffeinejs:distlock:extend',
  release: 'caffeinejs:distlock:release',
  contended: 'caffeinejs:distlock:contended',
  lost: 'caffeinejs:distlock:lost',
  election: 'caffeinejs:distlock:election',
} as const

/** Which call an acquisition came from: `tryAcquire`, `acquire`, or the one inside `once`. */
export type AcquireMode = 'try' | 'wait' | 'once'

/**
 * How an acquisition ended. `held` is a single attempt that found the key taken; `expired` is a single attempt
 * whose lease arrived already lapsed, and was given back; `timeout` is `acquire` spending its whole `wait`
 * budget; `aborted` is the caller's signal, which is not a backend failure. A backend call that outlived
 * `storeTimeout` is `error`, with `error` an `ErrLockBackendTimeout`.
 */
export type AcquireOutcome = 'acquired' | 'held' | 'expired' | 'timeout' | 'aborted' | 'error'

/** How an extension ended. `lost` means the backend no longer holds the key under this lease's token. */
export type ExtendOutcome = 'extended' | 'lost' | 'error'

/** How a `once` call ended. `failed` is any rejection: the action threw, or the acquisition itself did. */
export type OnceOutcome = 'executed' | 'skipped' | 'failed'

/**
 * What every context and message carries.
 *
 * `key` is chosen by whoever takes the lock and may be unbounded (`order:123`): fine on a span, a cardinality
 * hazard as a metric attribute.
 */
export interface LockEventBase {
  readonly service: DistLock
  readonly key: string
}

/** Set by `node:diagnostics_channel` when a traced call rejects. */
export interface TracedFailure {
  readonly error?: unknown
}

/** How many attempts of one acquisition the backend failed, by kind. */
export interface AcquireFailures {
  readonly timeout: number
  readonly other: number
}

export interface AcquireContext extends LockEventBase, TracedFailure {
  readonly mode: AcquireMode
  readonly ttl: Duration
  /** `0` for a single attempt. */
  readonly wait: Duration
  /**
   * The `withLock` or `once` call this acquisition ran inside, when there was one and its channel had
   * subscribers — what lets a span for this call nest under the span for that one.
   */
  readonly parent?: WithLockContext | OnceContext
  /** Absent in `start`; set by the time the call settles. */
  readonly outcome?: AcquireOutcome
  readonly attempts?: number
  /**
   * The attempts the backend failed, by kind: `timeout` did not answer within its deadline, `other` rejected. An
   * attempt the caller's signal cut short is in neither. Set by the time the call settles, whatever its outcome:
   * an acquisition that retried past a timeout counts it here and still ends `acquired`.
   */
  readonly failures?: AcquireFailures
  /** How long the call spent acquiring, from its first attempt to its outcome. */
  readonly waited?: Duration
  /** Present when `outcome` is `acquired`. */
  readonly leaseID?: number
  readonly expiresAt?: number
  /** The acquired lease's fencing token, present when `outcome` is `acquired`. */
  readonly fencingToken?: number
}

/** One `withLock` or `tryWithLock` call. */
export interface WithLockContext extends LockEventBase, TracedFailure {
  /**
   * `executed` once the key was taken and the action ran; `skipped` when `tryWithLock` found the key held. Absent
   * when the acquisition threw.
   */
  readonly outcome?: 'executed' | 'skipped'
  /** Present once the key was taken. */
  readonly leaseID?: number
  /** How long the action ran with the key held, measured when it returned or threw. */
  readonly held?: Duration
  /** Whether the lease was already gone when the action ended: the critical section outran it. */
  readonly lapsed?: boolean
}

export interface OnceContext extends LockEventBase, TracedFailure {
  readonly ttl: Duration
  readonly outcome?: OnceOutcome
  readonly leaseID?: number
  /** Whether the lease was already gone when the action ended. */
  readonly lapsed?: boolean
}

export interface ExtendContext extends LockEventBase, TracedFailure {
  /** Ties every event of one lease together, from acquisition to release. */
  readonly leaseID: number
  readonly ttl: Duration
  /** `true` for a background renewal, `false` for an explicit `Lock.extend`. */
  readonly renewal: boolean
  readonly outcome?: ExtendOutcome
  readonly expiresAt?: number
}

export interface ReleaseContext extends LockEventBase, TracedFailure {
  readonly leaseID: number
  /** The `withLock` call this release ran inside, when there was one and its channel had subscribers. */
  readonly parent?: WithLockContext
  readonly held?: Duration
  /** Whether the lease was already gone when it was released. */
  readonly lapsed?: boolean
}

/** One attempt that found the key held by someone else. */
export interface ContendedMessage extends LockEventBase {
  /** 1-based, within the call that made it. */
  readonly attempt: number
}

/**
 * How a lease was lost. `taken`: the backend holds the key under another token, or not at all. `expired`: the
 * lease lapsed by the clock with no renewal keeping it. `error`: a renewal could not reach the backend while the
 * lease still had time. `shutdown`: the lock service closed while the lease was still held.
 */
export type LostReason = 'taken' | 'expired' | 'error' | 'shutdown'

/** A lease this process believed it held and no longer does. Published once per lease. */
export interface LostMessage extends LockEventBase {
  readonly leaseID: number
  readonly reason: LostReason
  /** Whether a background renewal noticed it, rather than the deadline or an explicit extend. */
  readonly renewal: boolean
}

/**
 * What happened to a campaign's leadership. `elected`: it took the key. `lost`: the lease went without the campaign
 * letting go, with the reason. `stepped-down`: the campaign let go, because it was stopped or `onElected` failed.
 */
export type ElectionEvent = 'elected' | 'lost' | 'stepped-down'

/** One change of a campaign's leadership. Each leadership publishes `elected` once, then `lost` or `stepped-down` once. */
export interface ElectionMessage extends LockEventBase {
  readonly event: ElectionEvent
  /** The lease the campaign leads, or led, under. */
  readonly leaseID: number
  /** Why leadership was lost, on `lost` only. */
  readonly reason?: LostReason
}

/**
 * What `DistLock.events` emits: each tracing channel's context as it stands at `asyncEnd`, and each plain
 * channel's message, under the same names as {@link DIST_LOCK_CHANNELS}.
 */
export interface LockEventMap {
  acquire: [AcquireContext]
  withLock: [WithLockContext]
  once: [OnceContext]
  extend: [ExtendContext]
  release: [ReleaseContext]
  contended: [ContendedMessage]
  lost: [LostMessage]
  election: [ElectionMessage]
}
