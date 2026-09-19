import type { ConfigChange, ConfigChangeListener } from './types.js'

/** What one listener is owed: the value it last saw, and the newest one it has not seen yet. */
interface Delivery<V> {
  readonly listener: ConfigChangeListener<V>
  delivered: V
  pending: { value: V; change: ConfigChange } | undefined
  running: Promise<void> | undefined
}

/**
 * Delivers changes to whoever asked to hear about them, without ever making the change wait.
 *
 * - A listener never runs concurrently with itself, so a slow one cannot finish out of order and leave an older
 *   value applied.
 * - At most one delivery is pending per listener. A change arriving mid-flight replaces the pending one, so a slow
 *   listener gets the newest value rather than a backlog. The replacement lists every path the replaced changes did.
 * - A throw or a rejection goes to `onError`, and the other listeners carry on.
 *
 * The value it is constructed with is the baseline. Nothing is delivered for it.
 */
export class ChangeNotifier<V> {
  readonly #deliveries = new Set<Delivery<V>>()
  readonly #onError: (error: unknown) => void
  #latest: V
  #change: ConfigChange | undefined
  #baseline: V

  constructor(initial: V, onError: (error: unknown) => void) {
    this.#latest = initial
    this.#baseline = initial
    this.#onError = onError
  }

  /** Registers a listener and returns the call that removes it. It hears about changes from here on. */
  add(listener: ConfigChangeListener<V>): () => void {
    const delivery: Delivery<V> = { listener, delivered: this.#baseline, pending: undefined, running: undefined }
    this.#deliveries.add(delivery)

    return () => {
      delivery.pending = undefined
      this.#deliveries.delete(delivery)
    }
  }

  /** Records the newest value without telling anyone. */
  record(value: V, change: ConfigChange): void {
    this.#latest = value
    this.#change = change
  }

  /** Delivers the recorded value, if it is not the one delivered last. Returns at once. */
  flush(): void {
    const latest = this.#latest
    const change = this.#change

    if (Object.is(this.#baseline, latest) || change === undefined) {
      return
    }

    this.#baseline = latest

    for (const delivery of this.#deliveries) {
      const pending = delivery.pending
      delivery.pending = {
        value: latest,
        change:
          pending === undefined
            ? change
            : { revision: change.revision, changed: union(pending.change.changed, change.changed) },
      }
      delivery.running ??= this.#drain(delivery)
    }
  }

  /** Resolves once no delivery is running or pending. */
  async settled(): Promise<void> {
    for (;;) {
      const running = [...this.#deliveries].map(delivery => delivery.running).filter(promise => promise !== undefined)

      if (running.length === 0) {
        return
      }

      await Promise.all(running)
    }
  }

  /** Removes every listener. A delivery already running finishes; nothing pending is delivered. */
  clear(): void {
    for (const delivery of this.#deliveries) {
      delivery.pending = undefined
    }
    this.#deliveries.clear()
  }

  async #drain(delivery: Delivery<V>): Promise<void> {
    // Lets `flush` record this promise before the loop can finish and clear it.
    await Promise.resolve()

    try {
      while (delivery.pending !== undefined) {
        const { value, change } = delivery.pending
        const previous = delivery.delivered
        delivery.pending = undefined

        try {
          await delivery.listener(value, previous, change)
        } catch (error) {
          this.#onError(error)
        }

        delivery.delivered = value
      }
    } finally {
      delivery.running = undefined
    }
  }
}

function union(a: readonly string[], b: readonly string[]): readonly string[] {
  return [...new Set([...a, ...b])]
}
