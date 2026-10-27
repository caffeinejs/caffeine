import type { InferConfig, SchemaSatisfies } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'

import type { ResilienceHTTPConfig } from '../http/feature.js'

/**
 * The schema of the HTTP replay check's configuration block, satisfying {@link ResilienceHTTPConfig}. Hand the node
 * to `ResilienceHTTP((h, { config }) => h.config(...))`.
 *
 * `retryableMethods` is a list: `RESILIENCE_HTTP__RETRYABLE_METHODS=GET,HEAD,OPTIONS,TRACE,QUERY,PUT`.
 * Nothing is defaulted here.
 */
export const ResilienceHTTPConfigSchema = $t.Object({
  retryableMethods: $t.Optional($t.List($t.String({ minLength: 1 }))),
})

type _Satisfies = SchemaSatisfies<ResilienceHTTPConfig, InferConfig<typeof ResilienceHTTPConfigSchema>>
