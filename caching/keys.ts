import { token } from '@caffeinejs/di'

import type { ETagGenerator } from './cache.js'

/**
 * Convenience DI key for an {@link ETagGenerator}, for an application that wants to bind one and reference it
 * by token: `container.bind(kETagGenerator).toValue(myGenerator)`, then
 * `.with(HTTPCaching(b => b.etagGenerator(kETagGenerator)))`. `HTTPCaching` never binds this key itself. A
 * per-route `@Cache({ etagGenerator })` still takes precedence over it.
 */
export const kETagGenerator = token<ETagGenerator>(Symbol.for('@caffeinejs/caching:etag_generator'))
