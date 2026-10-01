import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { MessagingConfig } from './config.js'

const backoffSchema = $t.Union([
  $t.Object({ type: $t.Literal('fixed'), delay: $t.Number() }),
  $t.Object({
    type: $t.Literal('exponential'),
    delay: $t.Number(),
    multiplier: $t.Optional($t.Number()),
    max: $t.Optional($t.Number()),
  }),
])

/**
 * `options` is the binder's own bag and is carried through untouched. It is meant for data (`{ partitions: 3 }`).
 * `schema`, `classifier`, `notRetryable` and `retryable` are functions, schemas or error constructors, and stay
 * in code.
 */
const inBindingSchema = $t.Object({
  destination: $t.Optional($t.String()),
  via: $t.Optional($t.String()),
  group: $t.Optional($t.String()),
  contentType: $t.Optional($t.String()),
  retry: $t.Optional($t.Object({ attempts: $t.Number(), backoff: $t.Optional(backoffSchema) })),
  options: $t.Optional($t.Record($t.String(), $t.Unknown())),
})

const outBindingSchema = $t.Object({
  destination: $t.Optional($t.String()),
  via: $t.Optional($t.String()),
  contentType: $t.Optional($t.String()),
  options: $t.Optional($t.Record($t.String(), $t.Unknown())),
})

/**
 * The schema of one messaging instance's configuration block, satisfying {@link MessagingConfig}. Hand the node
 * to `Messaging((m, { config }) => m.config(...))`.
 *
 * Every field is optional: a binding is *declared* in code, and configuration only retunes what the declaration
 * already established.
 */
export const MessagingConfigSchema = $t.Object({
  in: $t.Optional($t.Record($t.String(), inBindingSchema)),
  out: $t.Optional($t.Record($t.String(), outBindingSchema)),
})

type _Satisfies = SchemaSatisfies<MessagingConfig, InferConfig<typeof MessagingConfigSchema>>
