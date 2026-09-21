import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { EventEmitter, captureRejectionSymbol } from 'node:events'

import type { Logger } from '@caffeinejs/std/logger'

import type { DistLock } from '../distlock.js'
import { DIST_LOCK_CHANNELS, type LockEventBase, type LockEventMap } from './channels.js'

type LockEventName = keyof LockEventMap

// Which `node:diagnostics_channel` each event is read from. Written as a `Record` over the event map, so an
// event added there and not here fails to compile. A tracing channel is read at `asyncEnd`, the one sub-event
// every call reaches, and by which point its context carries the outcome.
const sources: Record<LockEventName, string> = {
  acquire: `tracing:${DIST_LOCK_CHANNELS.acquire}:asyncEnd`,
  withLock: `tracing:${DIST_LOCK_CHANNELS.withLock}:asyncEnd`,
  once: `tracing:${DIST_LOCK_CHANNELS.once}:asyncEnd`,
  extend: `tracing:${DIST_LOCK_CHANNELS.extend}:asyncEnd`,
  release: `tracing:${DIST_LOCK_CHANNELS.release}:asyncEnd`,
  contended: DIST_LOCK_CHANNELS.contended,
  lost: DIST_LOCK_CHANNELS.lost,
}

function isLockEvent(event: string | symbol): event is LockEventName {
  return typeof event === 'string' && Object.hasOwn(sources, event)
}

/**
 * What one lock service did, as a typed `EventEmitter`. Read it from `DistLock.events`.
 *
 * It re-emits what the service published on its `node:diagnostics_channel` channels, keeping only that
 * service's own events. An event subscribes to its channel when its first listener arrives and unsubscribes
 * when its last one leaves, so an event nobody listens to costs the lock nothing.
 *
 * Listeners run synchronously, and the event for a call reaches them before the caller's `await` resumes. A
 * listener that throws stops the listeners after it for that one emit, as with any `EventEmitter`; the throw
 * and any rejection a listener returns are logged once per event on the lock service's logger and never reach
 * the lock or the process. There is no `error` event.
 *
 * Every payload is shared with the service's other subscribers, OpenTelemetry included: read it, never write to
 * it.
 */
export class LockEvents extends EventEmitter<LockEventMap> {
  readonly #service: DistLock
  readonly #log: Logger
  readonly #subscriptions = new Map<LockEventName, (message: unknown) => void>()
  readonly #reported = new Set<string>()

  constructor(service: DistLock, log: Logger) {
    super({ captureRejections: true })
    this.#service = service
    this.#log = log
    this.#hook()
  }

  // Put back straight away: `removeAllListeners()` takes the two hooks subscription runs on along with
  // everything else, and a later `on(...)` would then subscribe to nothing.
  override removeAllListeners(event?: LockEventName): this {
    // Node tells "remove everything" apart by the argument count, so an explicit `undefined` would remove nothing.
    if (event === undefined) {
      super.removeAllListeners()
    } else {
      super.removeAllListeners(event)
    }

    this.#hook()
    return this
  }

  override [captureRejectionSymbol](error: Error, event: string | symbol): void {
    this.#report(event, error)
  }

  #hook(): void {
    const untyped = this as EventEmitter

    if (!untyped.listeners('newListener').includes(this.#onNewListener)) {
      untyped.on('newListener', this.#onNewListener)
    }

    if (!untyped.listeners('removeListener').includes(this.#onRemoveListener)) {
      untyped.on('removeListener', this.#onRemoveListener)
    }
  }

  // Runs before the listener is added, so a count of zero means this is the first one.
  readonly #onNewListener = (event: string | symbol): void => {
    if (!isLockEvent(event) || this.#subscriptions.has(event)) {
      return
    }

    const onMessage = (message: unknown): void => this.#forward(event, message as LockEventBase)
    subscribe(sources[event], onMessage)
    this.#subscriptions.set(event, onMessage)
  }

  // Runs after the listener is removed, so a count of zero means that was the last one.
  readonly #onRemoveListener = (event: string | symbol): void => {
    if (!isLockEvent(event) || this.listenerCount(event) > 0) {
      return
    }

    const onMessage = this.#subscriptions.get(event)
    if (onMessage !== undefined) {
      unsubscribe(sources[event], onMessage)
      this.#subscriptions.delete(event)
    }
  }

  #forward(event: LockEventName, message: LockEventBase): void {
    if (message.service !== this.#service) {
      return
    }

    // Caught here: a throw left to `node:diagnostics_channel` would come back as an uncaught exception.
    try {
      ;(this as EventEmitter).emit(event, message)
    } catch (error) {
      this.#report(event, error)
    }
  }

  // The first failure from each event is logged; the rest are dropped, so a broken listener cannot flood the log
  // at the rate locks are taken.
  #report(event: string | symbol, error: unknown): void {
    const name = String(event)
    if (this.#reported.has(name)) {
      return
    }

    this.#reported.add(name)
    this.#log.warn(
      { err: error, event: name },
      `Lock event listener for "${name}" threw; further throws from "${name}" are suppressed`,
    )
  }
}
