import { $t } from '@caffeinejs/std'

import type { RetryPolicy } from './error_handling.js'

/**
 * The part of a binding that can live in a configuration tree.
 *
 * Destinations are the point: a topic or queue name differs between a laptop and a cluster exactly the way a
 * broker list does, and today it can only be changed by editing code.
 *
 * `schema`, `classifier`, `notRetryable` and `retryable` are left out — a schema carries transforms, a
 * classifier is a function, and the other two are error constructors. They stay on the builder and are merged
 * back once the slice publishes.
 *
 * `options` is the binder's own bag and is carried through untouched. It is meant for data (`{ partitions: 3 }`);
 * a function put in there cannot be cloned into the tree and fails the binding's slice by name at start-up.
 */
export interface BindingConfig {
  destination?: string
  via?: string
  group?: string
  contentType?: string
  retry?: RetryPolicy
  options?: Record<string, unknown>
}

/** One messaging instance's slice: its inbound and outbound bindings, keyed by the logical binding name. */
export interface MessagingConfigSlice {
  in?: Record<string, BindingConfig>
  out?: Record<string, BindingConfig>
}

/** The keys {@link BindingConfig} declares, used to split what the builder holds into its two halves. */
export const BINDING_CONFIG_KEYS: readonly (keyof BindingConfig)[] = [
  'destination',
  'via',
  'group',
  'contentType',
  'retry',
  'options',
]

const backoffSchema = $t.Union([
  $t.Object({ type: $t.Literal('fixed'), delay: $t.Number() }),
  $t.Object({
    type: $t.Literal('exponential'),
    delay: $t.Number(),
    multiplier: $t.Optional($t.Number()),
    max: $t.Optional($t.Number()),
  }),
])

const bindingSchema = $t.Object({
  destination: $t.Optional($t.String()),
  via: $t.Optional($t.String()),
  group: $t.Optional($t.String()),
  contentType: $t.Optional($t.String()),
  retry: $t.Optional($t.Object({ attempts: $t.Number(), backoff: $t.Optional(backoffSchema) })),
  options: $t.Optional($t.Record($t.String(), $t.Unknown())),
})

/**
 * The schema governing one messaging instance's slice.
 *
 * Every field is optional: a binding is *declared* in code, and configuration only retunes what the
 * declaration already established. A binding the tree names but no `.in(...)`/`.out(...)` created is read by
 * nothing.
 */
export const messagingConfigSchema = $t.Object({
  in: $t.Optional($t.Record($t.String(), bindingSchema)),
  out: $t.Optional($t.Record($t.String(), bindingSchema)),
})
