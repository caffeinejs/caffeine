import { degraded, down, HealthIndicator, type HealthReport, up } from '@caffeinejs/application/health'
import { errMessage } from '@caffeinejs/std/err'

import type { CircuitBreakerState } from '../circuitbreaker/circuitbreaker.js'
import { described, ErrInvalidOption } from '../errors.js'
import type { ResilienceDefinitions, ResilienceRegistry } from './registry.js'

/** What `Resilience(r => r.health(...))` takes. */
export interface ResilienceHealthOptions {
  /**
   * The presets whose open circuit breaker fails readiness. Any other breaker that is open reports `degraded`, which
   * keeps the probe passing. Defaults to none: a breaker usually guards a dependency every replica shares, and failing
   * readiness on it takes the whole service out of the load balancer at once.
   */
  readonly critical?: readonly string[]
}

// The states that refuse calls until a wait or an operator ends them. Half open is not one: its trial calls are what
// closes the breaker, so a probe that fails it would keep away the traffic it waits for.
const OPEN: ReadonlySet<CircuitBreakerState> = new Set<CircuitBreakerState>(['open', 'forced_open'])
const NOT_CLOSED: ReadonlySet<CircuitBreakerState> = new Set<CircuitBreakerState>([...OPEN, 'half_open'])

function healthError(message: string, ...solutions: string[]): ErrInvalidOption {
  return new ErrInvalidOption(
    errMessage(message)
      .solutions(...solutions)
      .reference('@caffeinejs/resilience', ErrInvalidOption)
      .build(),
  )
}

/**
 * The names in `options.critical`, each a preset that defines a circuit breaker able to leave the open state with no
 * call: a probe that fails keeps calls away, so a breaker that waits for one would fail readiness for good.
 *
 * @throws {@link ErrInvalidOption} when `critical` is not an array of strings, or names a preset with no circuit
 * breaker or one without `automaticTransitionFromOpenToHalfOpen`.
 */
export function criticalBreakers(options: ResilienceHealthOptions, definitions: ResilienceDefinitions): Set<string> {
  const critical: unknown = options.critical ?? []
  if (!Array.isArray(critical) || !critical.every(name => typeof name === 'string')) {
    throw healthError(
      `Cannot report the resilience health: critical must be an array of preset names, got ${described(critical)}`,
      "List the presets by name, such as r.health({ critical: ['payments'] })",
    )
  }

  for (const name of critical as string[]) {
    const defined = Object.hasOwn(definitions, name)
    const breaker = defined ? definitions[name]!.circuitBreaker : undefined
    if (breaker === undefined) {
      throw healthError(
        `Cannot report the health of preset "${name}": ${defined ? 'the preset defines no circuit breaker' : 'no preset by that name is defined'}`,
        `Add one with r.preset('${name}', p => p.circuitBreaker({ ... }))`,
        'Fix the name in r.health({ critical: [...] })',
      )
    }
    if (breaker.automaticTransitionFromOpenToHalfOpen !== true) {
      throw healthError(
        `Cannot report the health of preset "${name}": its circuit breaker leaves the open state only on a call, which a failing readiness probe keeps away`,
        `Set automaticTransitionFromOpenToHalfOpen: true in r.preset('${name}', p => p.circuitBreaker({ ... }))`,
        `Leave "${name}" out of critical, so its open breaker reports degraded`,
      )
    }
  }
  return new Set(critical as string[])
}

/**
 * The state of every circuit breaker, as one readiness indicator named `resilience`: `up` while none is open,
 * `degraded` while only breakers outside `critical` are open or any is half open, and `down` while a critical one
 * is open. `data.open` maps each breaker that is not closed to its state.
 */
export class ResilienceHealthIndicator extends HealthIndicator {
  readonly #registry: ResilienceRegistry
  readonly #critical: ReadonlySet<string>

  constructor(registry: ResilienceRegistry, critical: ReadonlySet<string>) {
    super()
    this.#registry = registry
    this.#critical = critical
  }

  get name(): string {
    return 'resilience'
  }

  check(): HealthReport {
    const open: Record<string, CircuitBreakerState> = {}
    let failing = false
    for (const breaker of this.#registry.circuitBreakers()) {
      const state = breaker.state
      if (NOT_CLOSED.has(state)) {
        open[breaker.name] = state
        failing ||= OPEN.has(state) && this.#critical.has(breaker.name)
      }
    }

    const names = Object.keys(open)
    if (names.length === 0) {
      return up()
    }
    const detail = names.map(name => `${name} is ${open[name]}`).join(', ')
    return failing ? down(detail, { open }) : degraded(detail, { open })
  }
}
