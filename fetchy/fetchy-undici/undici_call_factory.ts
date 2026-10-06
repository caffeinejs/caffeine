import type { Call, CallFactory } from '@caffeinejs/fetchy'
import { Pool } from 'undici'

import { UndiciCall } from './undici_call.js'

// A call over a pool its factory created, so closing the client closes the pool. A `UndiciCall` built over a caller's
// dispatcher has no `close()`, and leaves that dispatcher to the caller.
class PoolCall extends UndiciCall {
  constructor(private readonly pool: Pool) {
    super(pool)
  }

  close(): Promise<void> {
    return this.pool.close()
  }
}

/**
 * `CallFactory` that dispatches through an `undici` connection-pooling `Pool`, one `Pool` per
 * `provide()` call, that is one per `FetchyClient`. `FetchyClient.close()` closes it, once the
 * requests already sent complete.
 */
export class UndiciCallFactory implements CallFactory {
  constructor(private readonly options?: Pool.Options) {}

  provide(baseURL: string): Call {
    return new PoolCall(new Pool(new URL(baseURL).origin, this.options))
  }
}
