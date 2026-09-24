import { token } from '@caffeinejs/di'

import type { ETagGenerator } from './cache_control.js'
import type { HTTPCacheStore } from './store.js'

/**
 * Convenience DI key for an {@link ETagGenerator}, for an application that wants to bind one and reference it
 * by token: `container.bind(kETagGenerator).toValue(myGenerator)`, then
 * `.with(HTTPCaching(b => b.etagGenerator(kETagGenerator)))`. `HTTPCaching` never binds this key itself. A
 * per-route `@CacheControl({ etagGenerator })` still takes precedence over it.
 */
export const kETagGenerator = token<ETagGenerator>(Symbol.for('@caffeinejs/caching:etag_generator'))

/**
 * DI key for the {@link HTTPCacheStore}, for an application that binds its store and hands the token to
 * `.with(HTTPCaching(b => b.store(kHTTPCacheStore)))`. Bound that way, a service injects the store and evicts
 * by tag itself. `HTTPCaching` never binds this key.
 */
export const kHTTPCacheStore = token<HTTPCacheStore>(Symbol.for('@caffeinejs/caching:http_cache_store'))
