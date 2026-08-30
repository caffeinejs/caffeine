import { token } from '@caffeinejs/di'
import type { ETagGenerator } from './cache.js'

/**
 * DI key for the optional {@link ETagGenerator} used by the cache feature.
 *
 * `ETagGenerator` is a function type, not a class, so it cannot be a class-based DI token. Register a
 * generator with `container.bind(kETagGenerator).toValue(myGenerator)`; a per-route
 * `@Cache({ etagGenerator })` still takes precedence over the container-bound one.
 */
export const kETagGenerator = token<ETagGenerator>(Symbol.for('@caffeinejs/http:cache.etag_generator'))

/**
 * DI key for the cache-status response header name (default `X-Cache`). Bound by
 * `app.cache(c => c.statusHeader(name))`; the value carries HIT/MISS/BYPASS on every cached route.
 */
export const kCacheStatusHeader = token<string>(Symbol.for('@caffeinejs/http:cache.status_header'))
