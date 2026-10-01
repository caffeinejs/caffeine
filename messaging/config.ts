import type { InBindingOptions, OutBindingOptions } from './builder.js'

/**
 * What `MessagingBuilder.config` accepts: per binding, keyed by the logical binding name, the options to lay
 * over what `.in(...)` / `.out(...)` declared.
 *
 * Destinations are the point: a topic or queue name differs between a laptop and a cluster exactly the way a
 * broker list does.
 *
 * A binding named here that no `.in(...)`/`.out(...)` created is read by nothing: declaring a binding is a code
 * act.
 */
export interface MessagingConfig {
  in?: Readonly<Record<string, Partial<InBindingOptions>>>
  out?: Readonly<Record<string, Partial<OutBindingOptions>>>
}
