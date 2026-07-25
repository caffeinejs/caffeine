import type { RemoteAuthenticationTicket, RemoteAuthenticationTicketStore } from '@caffeinejs/http'

export interface TestOIDCTicketStoreOptions {
  /**
   * Time source for ticket expiry, in milliseconds.
   *
   * Defaults to a monotonic clock, so a wall-clock adjustment cannot extend a session. Pass
   * a counter to drive expiry deterministically — fake timers do not reach a monotonic clock.
   */
  clock?: { now: () => number }
}

interface StoredTicket {
  ticket: RemoteAuthenticationTicket
  expiresAt: number
}

/**
 * In-process ticket store for tests.
 *
 * Not a production store, and named so that using it as one is visible at the call site. It
 * keeps everything in a `Map` belonging to a single process: behind more than one instance a
 * session created on one node is unknown to the rest, and `removeBySubject` revokes only
 * where it was called — a "sign out everywhere" that silently misses nodes. Back a real
 * deployment with something shared, such as Redis.
 *
 * `removeBySubject` scans rather than maintaining an index. At the scale a test creates that
 * is the right trade: an index has to be kept in step with expiry and eviction, and an index
 * that drifts is worse than no index in exactly the operation that exists for erasure.
 */
export class TestOIDCTicketStore implements RemoteAuthenticationTicketStore {
  readonly #tickets = new Map<string, StoredTicket>()
  readonly #now: () => number

  constructor(options?: TestOIDCTicketStoreOptions) {
    this.#now = options?.clock?.now ?? (() => performance.now())
  }

  async store(key: string, ticket: RemoteAuthenticationTicket, ttlSeconds: number): Promise<void> {
    this.#tickets.set(key, { ticket, expiresAt: this.#now() + ttlSeconds * 1000 })
  }

  async retrieve(key: string): Promise<RemoteAuthenticationTicket | undefined> {
    const stored = this.#tickets.get(key)
    if (!stored) {
      return undefined
    }

    if (this.#now() >= stored.expiresAt) {
      this.#tickets.delete(key)
      return undefined
    }

    return stored.ticket
  }

  async remove(key: string): Promise<void> {
    this.#tickets.delete(key)
  }

  async removeBySubject(subject: string): Promise<void> {
    for (const [key, stored] of this.#tickets) {
      if (stored.ticket.subject === subject) {
        this.#tickets.delete(key)
      }
    }
  }

  /** Live ticket count, expired entries dropped. For assertions. */
  get size(): number {
    this.#purgeExpired()
    return this.#tickets.size
  }

  /** Forgets every ticket. Use between test cases sharing one store. */
  clear(): void {
    this.#tickets.clear()
  }

  #purgeExpired(): void {
    const now = this.#now()
    for (const [key, stored] of this.#tickets) {
      if (now >= stored.expiresAt) {
        this.#tickets.delete(key)
      }
    }
  }
}
