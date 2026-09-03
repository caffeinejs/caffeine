import { ErrCaffeine } from './error.js'

declare const kContributionType: unique symbol
declare const kContributionNeedsType: unique symbol

/**
 * Phantom brand that attaches a value type to a contribution key without a runtime object.
 */
export interface ContributionBrand<in out T> {
  readonly [kContributionType]: T
}

type ContributionNeedsTypeArg = { readonly [kContributionNeedsType]: true }

/**
 * A symbol branded with the type it holds. The return value is the plain symbol; `T` exists only at the
 * type level.
 */
export type ContributionKey<T> = symbol & ContributionBrand<T>

/**
 * Names a contribution and the type it carries.
 *
 * The type argument is required: without it the key is unusable, so a missing one is a compile error at the
 * declaration rather than an `unknown` that spreads to every read site.
 *
 * ```ts
 * export const kServerContribution = contributionKey<ServerOptions>('http:server')
 * ```
 */
export function contributionKey<T = never>(
  description: string,
): [T] extends [never] ? ContributionNeedsTypeArg : ContributionKey<T> {
  return Symbol(description) as never
}

function nameOf(key: symbol): string {
  return key.description ?? key.toString()
}

export class ErrContributionConflict extends ErrCaffeine {
  constructor(key: symbol) {
    super(`Cannot contribute "${nameOf(key)}": a contribution for that key already exists`, 'ERR_CONTRIBUTION_CONFLICT')
  }
}

export class ErrContributionPhase extends ErrCaffeine {
  constructor(message: string) {
    super(
      message,
      'ERR_CONTRIBUTION_PHASE',
      undefined,
      'Contribute from a service bootstrap step',
      'Read a contribution after the application has bootstrapped, e.g. while setting the platform up',
    )
  }
}

export class ErrNoContribution extends ErrCaffeine {
  constructor(key: symbol) {
    super(`Cannot resolve contribution "${nameOf(key)}": nothing contributed it`, 'ERR_NO_CONTRIBUTION')
  }
}

/**
 * What services hand the application on their way up: values a feature assembled while bootstrapping and the
 * application needs once everything is up.
 *
 * Writes and reads are separated in time rather than by convention. Services bootstrap concurrently, so a
 * contribution one of them reads while another is still writing would be decided by scheduling order; sealing
 * at the end of that step makes the question unaskable instead of answering it wrongly some of the time.
 *
 * This is not the container. A value belongs here when the framework carries it from a service to the
 * application and nothing resolves or injects it; anything user code injects is a binding.
 */
export class Contributions {
  readonly #values = new Map<symbol, unknown>()
  #sealed = false

  /** Whether the bootstrap step has closed and the contributions are readable. */
  get sealed(): boolean {
    return this.#sealed
  }

  contribute<T>(key: ContributionKey<T>, value: T): void {
    if (this.#sealed) {
      throw new ErrContributionPhase(`Cannot contribute "${nameOf(key)}": contributions are already sealed`)
    }

    if (this.#values.has(key)) {
      throw new ErrContributionConflict(key)
    }

    this.#values.set(key, value)
  }

  /** The contributed value, or {@link ErrNoContribution} when nothing contributed it. */
  get<T>(key: ContributionKey<T>): T {
    if (!this.has(key)) {
      throw new ErrNoContribution(key)
    }

    return this.#values.get(key) as T
  }

  /** The contributed value, or `undefined` — for a feature that is only there when it was configured. */
  find<T>(key: ContributionKey<T>): T | undefined {
    this.#assertSealed(key)
    return this.#values.get(key) as T | undefined
  }

  has<T>(key: ContributionKey<T>): boolean {
    this.#assertSealed(key)
    return this.#values.has(key)
  }

  /** Closes the writing step. Called by the application once every service has bootstrapped. */
  seal(): void {
    this.#sealed = true
  }

  #assertSealed(key: symbol): void {
    if (!this.#sealed) {
      throw new ErrContributionPhase(`Cannot read contribution "${nameOf(key)}": contributions are not sealed yet`)
    }
  }
}
