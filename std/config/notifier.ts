import type { ConfigChangeListener } from './config.js'
import { messageOf } from './errors.js'

/** What one listener is owed: the value it last saw, and the newest value it has not seen yet. */
interface Delivery<T> {
  listener: ConfigChangeListener<T>
  delivered: T
  pending: T | undefined
  hasPending: boolean
  running: Promise<void> | undefined
}

/**
 * Delivers configuration changes to whoever asked to hear about them.
 *
 * A refresh does **not** wait for listeners. A feature reacting to new configuration may take as long as it
 * needs — draining a pool, reopening a connection — and none of that should hold up the refresh or the features
 * that have nothing to do with it. Fire-and-forget on its own has three ways to go wrong, so:
 *
 * - **A listener never runs concurrently with itself.** Two refreshes landing close together would otherwise let
 *   a slow listener finish out of order and leave the *older* configuration applied.
 * - **At most one delivery is pending per listener.** A change arriving mid-flight replaces the pending value
 *   rather than queueing behind it, so a slow listener sees the newest configuration rather than working through
 *   a backlog of values that are already history.
 * - **A throw or rejection is caught** and reported through the warning channel. One bad listener neither stops
 *   the others nor becomes an unhandled rejection.
 *
 * This shape suits state notification, where only the latest value matters. It is the wrong shape for anything
 * that needs *every* transition — an audit trail of configuration changes — which would be a different tool.
 *
 * {@link settled} exists because fire-and-forget is otherwise untestable: nothing to await means no way to
 * assert what a listener did. Tests await it; nothing in the framework does.
 */
export class ConfigNotifier<T> {
  readonly #deliveries = new Set<Delivery<T>>()
  readonly #report: (message: string) => void
  readonly #describe: () => string
  #baseline: T | undefined
  #latest: T | undefined
  #started = false

  /**
   * @param describe - Names the configuration in a warning — a feature namespace, or the application.
   * @param report - Where a listener's failure goes. Read lazily: the application builder points the warning
   *   channel at the host after the configuration has already been described.
   */
  constructor(describe: () => string, report: () => ((message: string) => void) | undefined) {
    this.#describe = describe
    this.#report = message => report()?.(message)
  }

  /** Whether anything is listening. Nothing here costs anything while this is false. */
  get observed(): boolean {
    return this.#deliveries.size > 0
  }

  /** Registers a listener and returns the call that removes it. */
  add(listener: ConfigChangeListener<T>): () => void {
    const delivery: Delivery<T> = {
      listener,
      // Whatever is current is what this listener is considered to have seen, so it hears about changes from
      // here on rather than being told about one that happened before it existed.
      delivered: this.#latest as T,
      pending: undefined,
      hasPending: false,
      running: undefined,
    }

    this.#deliveries.add(delivery)

    return () => {
      this.#deliveries.delete(delivery)
    }
  }

  /**
   * Records the newest value without telling anyone. Called every time configuration is published, including at
   * start-up — the first publish establishes what "unchanged" means and is never itself a change.
   */
  record(value: T): void {
    if (!this.#started) {
      this.#baseline = value
      this.#started = true
    }
    this.#latest = value
  }

  /**
   * Delivers the recorded value if it actually differs from the last one delivered.
   *
   * Separate from {@link record} so that every slice can be published before any listener runs. Otherwise the
   * first feature notified would go looking at another feature's configuration and find it stale.
   */
  flush(): void {
    const latest = this.#latest as T

    if (!this.observed) {
      // Nothing is listening, so nothing is compared. The baseline still moves, or a listener registering later
      // would be told about a change that predates it.
      this.#baseline = latest
      return
    }

    if (configEquals(this.#baseline, latest)) {
      return
    }

    this.#baseline = latest

    for (const delivery of this.#deliveries) {
      delivery.pending = latest
      delivery.hasPending = true
      this.#deliver(delivery)
    }
  }

  /** Resolves once nothing is in flight or pending. For tests; production has no reason to wait. */
  async settled(): Promise<void> {
    for (;;) {
      const running = [...this.#deliveries].map(d => d.running).filter(p => p !== undefined)

      if (running.length === 0) {
        return
      }

      await Promise.all(running)
    }
  }

  #deliver(delivery: Delivery<T>): void {
    delivery.running ??= this.#drain(delivery)
  }

  async #drain(delivery: Delivery<T>): Promise<void> {
    // Yield once so the caller has recorded this promise before the loop can finish and clear it. Without it a
    // listener that completes immediately would clear a field that has not been assigned yet.
    await Promise.resolve()

    try {
      while (delivery.hasPending) {
        const value = delivery.pending as T
        const previous = delivery.delivered

        delivery.pending = undefined
        delivery.hasPending = false

        try {
          await delivery.listener(value, previous)
        } catch (error) {
          this.#report(`A configuration change listener for "${this.#describe()}" failed: ${messageOf(error)}`)
        }

        delivery.delivered = value
      }
    } finally {
      delivery.running = undefined
    }
  }
}

/**
 * Whether two configurations are the same.
 *
 * Arrays and plain objects are compared member by member; **everything else is compared by identity**. That is
 * deliberate rather than a shortcut: a derived configuration carries values that never came from a
 * configuration tree at all — a dispatcher, a handler, a class — and for those, being the same object is the
 * only meaning "unchanged" can honestly have.
 */
export function configEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false
    }
    return a.every((element, i) => configEquals(element, b[i]))
  }

  if (!isPlainObject(a) || !isPlainObject(b)) {
    return false
  }

  const keys = Object.keys(a)

  if (keys.length !== Object.keys(b).length) {
    return false
  }

  return keys.every(key => key in b && configEquals(a[key], b[key]))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const prototype = Object.getPrototypeOf(value) as unknown

  return prototype === Object.prototype || prototype === null
}
