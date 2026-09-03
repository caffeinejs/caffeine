import type { ApplicationAvailability } from '@caffeinejs/std'

import type { HealthOptions } from './options.js'
import type { GroupOutcome, HealthRegistry, IndicatorOutcome } from './registry.js'

/** The query a probe request carries. Both parameters are honoured only when enabled in {@link HealthOptions}. */
export interface ProbeQuery {
  verbose?: boolean
  exclude?: readonly string[]
}

/** A rendered probe response, independent of any HTTP server. */
export interface ProbeResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const PROBE_HEADERS: Record<string, string> = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
}

/** One line of the probe's own state, rendered alongside the indicator lines in a verbose body. */
interface StateLine {
  name: string
  ok: boolean
  detail?: string
}

/**
 * Renders the three probes from the {@link ApplicationAvailability} and the {@link HealthRegistry}, in the
 * plain-text shape `kubectl get --raw /readyz?verbose` already produces.
 *
 * Deliberately free of any server type: the Fastify configurer adapts it, and any other adapter can reuse it
 * through `Services.health`.
 */
export class ProbeEndpoint {
  readonly #availability: ApplicationAvailability
  readonly #registry: HealthRegistry
  readonly #options: HealthOptions

  constructor(availability: ApplicationAvailability, registry: HealthRegistry, options: HealthOptions) {
    this.#availability = availability
    this.#registry = registry
    this.#options = options
  }

  /**
   * Liveness. Reaching this method is itself the answer: the event loop is turning and the process is not
   * deadlocked, which is the entire question the orchestrator is asking. It fails only on an explicit
   * `markBroken()` or on an indicator a user deliberately placed in the `liveness` group.
   *
   * Nothing here touches a dependency. A liveness probe that can fail because a database blinked converts a
   * dependency outage into a restart storm.
   */
  async live(query: ProbeQuery = {}): Promise<ProbeResponse> {
    const availability = this.#availability
    const state: StateLine[] = [
      { name: 'live', ok: availability.live === 'correct', detail: availability.livenessReason },
    ]

    const outcome = availability.live === 'correct' ? await this.#evaluate('liveness', query) : undefined

    return this.#render('livez', state, outcome, query)
  }

  /**
   * Readiness. Fails while booting, while draining, and when a critical indicator is down. The state checks come
   * first so a draining process answers without touching a single dependency.
   */
  async ready(query: ProbeQuery = {}): Promise<ProbeResponse> {
    const availability = this.#availability
    const state: StateLine[] = [
      { name: 'started', ok: availability.started, detail: availability.started ? undefined : 'starting' },
      { name: 'accepting', ok: availability.ready === 'accepting', detail: availability.readinessReason },
      { name: 'live', ok: availability.live === 'correct', detail: availability.livenessReason },
    ]

    const outcome = state.every(line => line.ok) ? await this.#evaluate('readiness', query) : undefined

    return this.#render('readyz', state, outcome, query)
  }

  /** Startup. Passes once boot completed, so a slow boot never gets the container killed mid-initialization. */
  async startup(query: ProbeQuery = {}): Promise<ProbeResponse> {
    const availability = this.#availability
    const state: StateLine[] = [
      { name: 'started', ok: availability.started, detail: availability.started ? undefined : 'starting' },
    ]

    const outcome = availability.started ? await this.#evaluate('startup', query) : undefined

    return this.#render('startupz', state, outcome, query)
  }

  #evaluate(group: 'liveness' | 'readiness' | 'startup', query: ProbeQuery): Promise<GroupOutcome> | undefined {
    if (!this.#registry.has(group)) {
      return undefined
    }

    // An unhonoured `exclude` only ever makes the check stricter, which is the safe direction to fail in. Rejecting
    // the request instead would let a caller's query string take the pod out of the routing table.
    const exclude = this.#options.exclude && query.exclude !== undefined ? new Set(query.exclude) : undefined

    return this.#registry.evaluate(group, exclude)
  }

  #render(
    probe: string,
    state: readonly StateLine[],
    outcome: GroupOutcome | undefined,
    query: ProbeQuery,
  ): ProbeResponse {
    const ok = state.every(line => line.ok) && (outcome?.ok ?? true)
    const status = ok ? 200 : 503

    if (!(this.#options.verbose && query.verbose === true)) {
      return { status, headers: PROBE_HEADERS, body: ok ? 'ok' : `${probe} check failed` }
    }

    const lines = state.map(line => renderLine(line.name, line.ok, line.detail))
    for (const indicator of outcome?.outcomes ?? []) {
      lines.push(renderIndicator(indicator))
    }
    lines.push(`${probe} check ${ok ? 'passed' : 'failed'}`)

    return { status, headers: PROBE_HEADERS, body: lines.join('\n') + '\n' }
  }
}

function renderLine(name: string, ok: boolean, detail?: string): string {
  if (ok) {
    return `[+]${name} ok`
  }

  return detail === undefined ? `[-]${name} failed` : `[-]${name} failed: ${detail}`
}

function renderIndicator(outcome: IndicatorOutcome): string {
  if (outcome.status === 'up') {
    return `[+]${outcome.name} ok`
  }

  const label = outcome.status === 'degraded' || !outcome.critical ? 'degraded' : 'failed'
  const suffix = outcome.detail === undefined ? '' : `: ${outcome.detail}`

  return `[-]${outcome.name} ${label}${suffix}`
}
