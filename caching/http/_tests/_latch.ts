import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import type {
  HTTPCacheCallOptions,
  HTTPCacheEntry,
  HTTPCacheGetOptions,
  HTTPCachePutOptions,
  HTTPCacheStore,
} from '../index.js'

/** A handler that waits to be let go, so requests pile up behind it on purpose. */
export function gate() {
  let open!: () => void
  let entered!: () => void
  const opened = new Promise<void>(resolve => (open = resolve))
  const seen = new Promise<void>(resolve => (entered = resolve))

  return {
    open,
    /** Resolves once the handler has been entered. */
    seen,
    async hold() {
      entered()
      await opened
    },
  }
}

/** Counts what happens; `reached(n)` resolves once it has happened `n` times, at once when it already has. */
export function counter() {
  let count = 0
  const waiting: { n: number; resolve: () => void }[] = []

  return {
    get count() {
      return count
    },
    tick() {
      count++
      for (const waiter of waiting.splice(0)) {
        if (count >= waiter.n) {
          waiter.resolve()
        } else {
          waiting.push(waiter)
        }
      }
    },
    reached(n: number): Promise<void> {
      return count >= n ? Promise.resolve() : new Promise(resolve => waiting.push({ n, resolve }))
    },
  }
}

/**
 * A store that counts the reads and writes it is asked for, so a test waits for the n-th one instead of for a
 * stretch of time. Every call goes on to the store it wraps.
 */
export class WatchedStore implements HTTPCacheStore {
  readonly reads = counter()
  readonly writes = counter()

  constructor(readonly inner: HTTPCacheStore = new MemoryHTTPCacheStore()) {}

  get(key: string, options?: HTTPCacheGetOptions): Promise<HTTPCacheEntry | undefined> {
    this.reads.tick()
    return this.inner.get(key, options)
  }

  put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions): Promise<void> {
    this.writes.tick()
    return this.inner.put(key, entry, options)
  }

  evictByTag(tags: string | readonly string[], options?: HTTPCacheCallOptions): Promise<void> {
    return this.inner.evictByTag(tags, options)
  }
}

/**
 * One turn of the event loop. A read that has been asked for and answers from memory has, by then, run what it
 * set going in microtasks: the miss, and the wait on another request's handler run.
 */
export function turn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** Resolves once `signal` aborts, at once when it already has. */
export function whenAborted(signal: AbortSignal): Promise<void> {
  return signal.aborted
    ? Promise.resolve()
    : new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}
