type Listener<E> = (event: E) => unknown

// A listener's failure must never become the failure of the call that emitted: it resurfaces on its own
// microtask, where the runtime reports it as uncaught.
function rethrow(error: unknown): void {
  queueMicrotask(() => {
    throw error
  })
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Synchronous, typed events. Listener arrays are replaced on every `on` and removal, never mutated, so `emit`
 * iterates a stable array without copying it.
 */
export class Emitter<Events extends object> {
  #listeners: { [K in keyof Events]?: readonly Listener<Events[K]>[] } = {}
  #size = 0

  /** Listeners of every type; lets a call site with nothing listening skip the per-type lookup. */
  get size(): number {
    return this.#size
  }

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    this.#listeners[type] = [...(this.#listeners[type] ?? []), listener]
    this.#size++

    let removed = false
    return () => {
      if (removed) {
        return
      }

      removed = true
      const current = this.#listeners[type]
      const index = current === undefined ? -1 : current.indexOf(listener)
      if (current === undefined || index === -1) {
        return
      }

      const next = current.slice()
      next.splice(index, 1)
      this.#listeners[type] = next.length === 0 ? undefined : next
      this.#size--
    }
  }

  has<K extends keyof Events>(type: K): boolean {
    if (this.#size === 0) {
      return false
    }

    const listeners = this.#listeners[type]
    return listeners !== undefined && listeners.length > 0
  }

  emit<K extends keyof Events>(type: K, event: Events[K]): void {
    const listeners = this.#listeners[type]
    if (listeners === undefined) {
      return
    }

    for (let i = 0; i < listeners.length; i++) {
      try {
        const returned = listeners[i](event)
        if (isThenable(returned)) {
          returned.then(undefined, rethrow)
        }
      } catch (error) {
        rethrow(error)
      }
    }
  }
}
