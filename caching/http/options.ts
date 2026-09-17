import type { InjectionToken } from '@caffeinejs/di'

import type { Cache } from '../store.js'
import type { ETagGenerator } from './cache.js'

/** The default cache-status response header name, carrying HIT/MISS/BYPASS. */
export const DEFAULT_STATUS_HEADER = 'X-Cache'

/**
 * What `HTTPCaching(...)` takes: a plain options object, resolved once as the plugin registers.
 *
 * `store` and `etagGenerator` each accept either the value itself or an {@link InjectionToken} to read it
 * from the container at plugin-setup time — `HTTPCaching` never binds either into the container itself.
 */
export interface HTTPCachingOptions {
  /**
   * The store backing cached responses, or a token to resolve one from the container. A real {@link Cache}
   * instance is told apart from an {@link InjectionToken} by shape: a class, a `DeferredCtor`, or a
   * string/symbol is a token, anything else (a plain object) is the store itself. Required — installing
   * `HTTPCaching` without one throws `ErrConfiguration`.
   */
  store?: Cache | InjectionToken<Cache>
  /**
   * The function hashing a payload into an `ETag`, or a token to resolve one from the container — a
   * `string`/`symbol` is a token, a `function` is the generator itself. Defaults to an internal SHA-1 hash
   * when omitted.
   */
  etagGenerator?: ETagGenerator | InjectionToken<ETagGenerator>
  /** The cache-status response header name. Defaults to {@link DEFAULT_STATUS_HEADER}. */
  statusHeader?: string
}
