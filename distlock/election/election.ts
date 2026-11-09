import type { Logger } from '@caffeinejs/application/logger'
import type { Backoff } from '@caffeinejs/resilience'
import type { Duration } from '@caffeinejs/std/duration'

import type { AcquireOptions, Lock } from '../distlock.js'
import { ErrLockLost } from '../errors.js'
import type { ElectionEvent, LostReason } from '../observability/channels.js'

/** How {@link DistLock.campaign} campaigns for a key. */
export interface CampaignOptions {
  /** How long each lease lasts. Renewed while leading. Defaults to the service's `ttl`. */
  ttl?: Duration

  /**
   * Called with the lock once this campaign is elected. It is not awaited before the campaign watches the lease: a
   * throw or a rejection releases the key, and the campaign tries again after one backoff pause.
   */
  onElected?: (lock: Lock) => void | Promise<void>

  /** Called once per lost leadership, with the reason. Not called when the campaign itself let go. */
  onLost?: (reason: LostReason) => void

  /** Aborting it stops the campaign, as {@link Campaign.stop} does. */
  signal?: AbortSignal
}

/** A running campaign for one key, from {@link DistLock.campaign}. */
export interface Campaign {
  readonly key: string

  /**
   * `true` while this campaign holds a lease that has not lapsed by the clock. Leadership is not exclusive across a
   * pause longer than the lease: leader-only work that writes shared state checks `lock.fencingToken` at the
   * resource.
   */
  readonly isLeader: boolean

  /** The lock while leading, `undefined` otherwise. */
  readonly lock: Lock | undefined

  /** Releases leadership, if held, and stops campaigning. Resolves once the campaign has ended. Idempotent. */
  stop(): Promise<void>

  [Symbol.asyncDispose](): Promise<void>
}

// What a campaign needs from the lock service that runs it. Passed in rather than imported, so this module reaches
// no private module of the package.
export interface CampaignHost {
  tryAcquire(key: string, options: AcquireOptions): Promise<Lock | undefined>
  readonly backoff: Backoff
  readonly log: Logger
  publishElection(key: string, event: ElectionEvent, leaseID: number, reason?: LostReason): void
}

// How one leadership ended.
type Ending =
  | { readonly kind: 'lost'; readonly reason: unknown }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'stopped' }

export class CampaignRunner implements Campaign {
  readonly key: string

  readonly #host: CampaignHost
  readonly #options: CampaignOptions
  // Aborted by `stop()`: it ends whatever the loop is waiting on, an attempt, a pause or a leadership.
  readonly #stop = new AbortController()
  readonly #done: Promise<void>
  #lock: Lock | undefined
  // Whether a hook already failed, so the failures after it stay at `debug`.
  #electedFailed = false
  #lostFailed = false

  constructor(host: CampaignHost, key: string, options: CampaignOptions) {
    this.key = key
    this.#host = host
    this.#options = options

    const { signal } = options
    if (signal?.aborted === true) {
      this.#stop.abort()
    } else {
      signal?.addEventListener('abort', () => void this.stop(), { once: true, signal: this.#stop.signal })
    }

    // The caller gets the handle first; the loop starts on the next microtask.
    this.#done = Promise.resolve().then(() => this.#run())
  }

  // Settles once the campaign has ended, whoever stopped it.
  get done(): Promise<void> {
    return this.#done
  }

  get isLeader(): boolean {
    return this.#lock !== undefined && !this.#lock.lost
  }

  get lock(): Lock | undefined {
    return this.#lock
  }

  stop(): Promise<void> {
    this.#stop.abort()
    return this.#done
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.stop()
  }

  get #stopped(): boolean {
    return this.#stop.signal.aborted
  }

  // Never rejects: every failure inside is logged and campaigned past, until the campaign is stopped.
  async #run(): Promise<void> {
    let attempt = 0

    while (!this.#stopped) {
      let lock: Lock | undefined
      try {
        lock = await this.#host.tryAcquire(this.key, {
          ttl: this.#options.ttl,
          renew: true,
          signal: this.#stop.signal,
        })
      } catch (error) {
        // The lock service already warned about a backend failure; the campaign only carries on.
        if (!this.#stopped) {
          this.#host.log.debug({ err: error, key: this.key }, 'lock campaign attempt failed')
        }
      }

      if (lock === undefined) {
        attempt += 1
        await this.#pause(attempt)
        continue
      }

      attempt = 0
      if (await this.#lead(lock)) {
        // A hook that fails, or a holder that hands the key back, every time must not turn the campaign into a hot
        // loop.
        await this.#pause(1)
      }
    }
  }

  // Leads until the lease is lost, the campaign is stopped, or `onElected` fails. Says whether to pause before the
  // next attempt: after `onElected` failed, or after the holder let go of the lock itself.
  async #lead(lock: Lock): Promise<boolean> {
    this.#lock = lock
    this.#host.publishElection(this.key, 'elected', lock.leaseID)
    this.#host.log.debug({ key: this.key, leaseID: lock.leaseID }, 'lock campaign elected')

    const ending = await this.#watch(lock)
    this.#lock = undefined

    if (ending.kind === 'lost') {
      return this.#lost(lock, ending.reason)
    }

    if (ending.kind === 'failed') {
      const fields = { err: ending.error, key: this.key, leaseID: lock.leaseID }
      if (this.#electedFailed) {
        this.#host.log.debug(fields, 'lock campaign onElected failed')
      } else {
        this.#electedFailed = true
        this.#host.log.warn(fields, 'lock campaign onElected failed')
      }
    }

    // A release that fails was logged by the lock service; the lease lapses at its expiry.
    await lock.release().catch(() => undefined)
    this.#host.publishElection(this.key, 'stepped-down', lock.leaseID)
    this.#host.log.debug({ key: this.key, leaseID: lock.leaseID }, 'lock campaign stepped down')

    return ending.kind === 'failed'
  }

  // Watches the lease from the moment it is taken, while `onElected` runs, and settles on the first way it ends.
  #watch(lock: Lock): Promise<Ending> {
    return new Promise<Ending>(resolve => {
      const done = new AbortController()
      const end = (ending: Ending) => {
        done.abort()
        resolve(ending)
      }

      if (this.#stopped) {
        end({ kind: 'stopped' })
        return
      }
      if (lock.signal.aborted) {
        end({ kind: 'lost', reason: lock.signal.reason })
        return
      }

      this.#stop.signal.addEventListener('abort', () => end({ kind: 'stopped' }), { once: true, signal: done.signal })
      lock.signal.addEventListener('abort', () => end({ kind: 'lost', reason: lock.signal.reason }), {
        once: true,
        signal: done.signal,
      })

      const { onElected } = this.#options
      if (onElected !== undefined) {
        Promise.try(onElected, lock).then(undefined, (error: unknown) => end({ kind: 'failed', error }))
      }
    })
  }

  // Says whether the leadership ended as a step-down rather than a loss.
  async #lost(lock: Lock, cause: unknown): Promise<boolean> {
    // Anything but a loss is the holder's own `lock.release()`, which already gave the key back: the campaign let go.
    if (!(cause instanceof ErrLockLost)) {
      this.#host.publishElection(this.key, 'stepped-down', lock.leaseID)
      this.#host.log.debug({ key: this.key, leaseID: lock.leaseID }, 'lock campaign stepped down')
      return true
    }

    const { reason } = cause
    this.#host.publishElection(this.key, 'lost', lock.leaseID, reason)
    this.#host.log.debug({ key: this.key, leaseID: lock.leaseID, reason }, 'lock campaign lost')

    // The service is closing: a new lease would be ended as it arrives.
    if (reason === 'shutdown') {
      this.#stop.abort()
    }

    try {
      this.#options.onLost?.(reason)
    } catch (error) {
      const fields = { err: error, key: this.key, leaseID: lock.leaseID }
      if (this.#lostFailed) {
        this.#host.log.debug(fields, 'lock campaign onLost failed')
      } else {
        this.#lostFailed = true
        this.#host.log.warn(fields, 'lock campaign onLost failed')
      }
    }

    // Another holder has the key when it was taken, and a closing service leaves its keys to lapse. Otherwise the
    // backend may still hold it under this token: hand it back, token-checked, so the next campaigner does not wait
    // out the lease.
    if (reason !== 'taken' && reason !== 'shutdown') {
      await lock.release().catch(() => undefined)
    }

    return false
  }

  // One backoff pause, cut short by `stop()`.
  #pause(attempt: number): Promise<void> {
    return new Promise(resolve => {
      if (this.#stopped) {
        resolve()
        return
      }

      let delay: number
      try {
        delay = this.#host.backoff(attempt)
      } catch (error) {
        // Without a pause the campaign could only spin: it ends, loudly, and `done` still resolves.
        this.#host.log.warn({ err: error, key: this.key }, 'lock campaign stopped: backoff failed')
        this.#stop.abort()
        resolve()
        return
      }

      const onStop = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.#stop.signal.removeEventListener('abort', onStop)
        resolve()
      }, delay)
      // Never the last thing keeping a process alive.
      timer.unref?.()
      this.#stop.signal.addEventListener('abort', onStop, { once: true })
    })
  }
}
