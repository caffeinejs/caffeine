import type { Call, CallFactory } from '@caffeinejs/fetchy'
import { Pool } from 'undici'

import { UndiciCall } from './undici_call.js'

/**
 * `CallFactory` that dispatches through an `undici` connection-pooling `Pool`, one `Pool` per
 * `provide()` call (i.e. one per `FetchyClient`, since `FetchyClient` calls `provide()` exactly
 * once). There is no automatic teardown hook in fetchy's client lifecycle — keep a reference to
 * this factory and call `factory.pool()?.close()` yourself once done with the client.
 */
export class UndiciCallFactory implements CallFactory {
  private _pool: Pool | undefined

  constructor(private readonly options?: Pool.Options) {}

  pool(): Pool | undefined {
    return this._pool
  }

  provide(baseURL: string): Call {
    this._pool = new Pool(new URL(baseURL).origin, this.options)
    return new UndiciCall(this._pool)
  }
}
