import type { Transport, TransportFactory } from '@caffeinejs/fetchy'
import { Pool } from 'undici'

import { UndiciTransport } from './undici_transport.js'

// A transport over a pool its factory created, so closing the client closes the pool. A `UndiciTransport` built over a
// caller's dispatcher has no `close()`, and leaves that dispatcher to the caller.
class PoolTransport extends UndiciTransport {
  constructor(private readonly pool: Pool) {
    super(pool)
  }

  close(): Promise<void> {
    return this.pool.close()
  }
}

/**
 * `TransportFactory` that dispatches through an `undici` connection-pooling `Pool`, one `Pool` per
 * `provide()` call, that is one per `FetchyClient`. `FetchyClient.close()` closes it, once the
 * requests already sent complete.
 */
export class UndiciTransportFactory implements TransportFactory {
  constructor(private readonly options?: Pool.Options) {}

  provide(baseURL: string): Transport {
    return new PoolTransport(new Pool(new URL(baseURL).origin, this.options))
  }
}
