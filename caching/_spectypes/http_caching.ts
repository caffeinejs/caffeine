import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { HTTPCachingOptions } from '../http/options.js'

/**
 * The schema of the HTTP caching configuration block, satisfying {@link HTTPCachingOptions}. Hand the node to
 * `HTTPCaching((b, { config }) => b.config(...))`.
 *
 * The store, the ETag generator and the observer are objects or container tokens, and stay in code.
 *
 * The timeouts are `$t.Duration()` and `maxEntrySize` is `$t.Bytes()`: a bare number, whose unit would be
 * ambiguous, fails validation at `bootstrap()`. `varyByQuery` is a `$t.List`, so `CACHE__VARY_BY_QUERY=page,sort`
 * is two parameters.
 */
export const HTTPCachingConfigSchema = $t.Object({
  statusHeader: $t.Optional($t.String()),
  storeTimeout: $t.Optional($t.Duration()),
  lockTimeout: $t.Optional($t.Duration()),
  varyByQuery: $t.Optional($t.List($t.String())),
  maxEntrySize: $t.Optional($t.Bytes()),
})

type _Satisfies = SchemaSatisfies<HTTPCachingOptions, InferConfig<typeof HTTPCachingConfigSchema>>
