import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { AnySchema } from '../schema/schema.js'
import { validateSchema } from '../schema/validate.js'
import { ErrConfigValidation } from './errors.js'
import type { ConfigSchema } from './types.js'

/**
 * The schema an application that never declared one gets: the tree passes through untouched rather than meeting
 * constraints nobody wrote.
 */
export const passthroughConfigSchema: StandardSchemaV1<unknown, unknown> = {
  '~standard': {
    version: 1,
    vendor: 'caffeine',
    validate: value => ({ value }),
  },
}

/**
 * Validates and returns the typed configuration. Validation is synchronous: a schema whose validator returns a
 * `Promise` (async refinement) is rejected, because a reload swaps the new configuration in one synchronous step.
 *
 * Keys no schema declares are dropped, not rejected — the raw configuration is the union of every provider, so an
 * environment variable that belongs to some other tool must not fail startup.
 *
 * Codecs run here, and only here. Configuration is where values arrive as text — an environment variable, a
 * command-line argument — so a schema declaring `$t.List` or `$t.JSON` is decoded as part of validating it. A
 * Standard Schema is unaffected: it runs its own validator, transforms included, exactly as authored.
 */
export function validateConfig<T>(schema: ConfigSchema<T>, input: unknown): T {
  const result = validateSchema(schema as AnySchema, input, { decode: true })

  if (!result.ok) {
    throw new ErrConfigValidation(result.issues)
  }

  return result.value as T
}
