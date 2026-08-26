import { ErrCaffeine } from '../error.js'
import type { SchemaIssue } from '../schema/schema.js'

/**
 * Every failure in `std/config`.
 *
 * One class rather than one per situation: the two things a caller actually does with a configuration error are
 * telling it apart from an unrelated throw (`instanceof ErrConfig`) and branching on which situation it was
 * (`error.code`), and a class hierarchy buys neither of those. The subclasses below exist only where a caller
 * needs to read structured data off the error; everything else is an `ErrConfig` with its own code.
 */
export class ErrConfig extends ErrCaffeine {}

export class ErrConfigValidation extends ErrConfig {
  constructor(
    public readonly issues: SchemaIssue[],
    cause?: unknown,
  ) {
    const detail = issues.length > 0 ? `: ${issues.map(i => `${i.path}: ${i.message}`).join('; ')}` : ''
    super(`Config validation failed${detail}`, 'ERR_CONFIG_VALIDATION', cause)
  }
}

/** One feature's configuration failing, carried with the namespace it belongs to. */
export interface ConfigSliceFailure {
  path: string
  error: unknown
}

export class ErrConfigSlices extends ErrConfig {
  constructor(readonly failures: readonly ConfigSliceFailure[]) {
    const detail = failures.map(f => `${f.path}: ${messageOf(f.error)}`).join('; ')
    super(`Cannot resolve configuration for ${failures.length} feature(s): ${detail}`, 'ERR_CONFIG_SLICES')
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
