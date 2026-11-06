import type { Logger } from '@caffeinejs/application/logger'
import { logToken } from '@caffeinejs/application/logger'
import { Injectable, type OnDestroy } from '@caffeinejs/di'
import { type FetchyClient, newClient } from '@caffeinejs/fetchy'
import { UndiciTransportFactory } from '@caffeinejs/fetchy-undici'
import { compose, type Operation, type PolicyLike } from '@caffeinejs/resilience'
import { ResilienceRegistry } from '@caffeinejs/resilience/aop'
import { ErrBulkheadFull } from '@caffeinejs/resilience/bulkhead'
import { ErrCallNotPermitted } from '@caffeinejs/resilience/circuitbreaker'
import { fallback } from '@caffeinejs/resilience/fallback'
import { ErrRateLimitExceeded } from '@caffeinejs/resilience/ratelimiter'
import { ErrTimeLimitExceeded } from '@caffeinejs/resilience/timelimiter'

import { type Config, type DSPConfig, kConfig } from '../app.config.js'
import { DSPAPI } from './dsp.api.js'
import {
  type BidRequest,
  type BidResponse,
  type BidResult,
  type DSPStatus,
  type Outcome,
  OUTCOMES,
} from './dsp.schemas.js'

/** Why a DSP gave no bid, read from what its policies or its client threw. */
function outcomeOf(error: unknown): Outcome {
  if (error instanceof ErrTimeLimitExceeded) {
    return 'timeout'
  }
  if (error instanceof ErrCallNotPermitted) {
    return 'circuit_open'
  }
  if (error instanceof ErrRateLimitExceeded) {
    return 'rate_limited'
  }
  if (error instanceof ErrBulkheadFull) {
    return 'bulkhead_full'
  }
  return 'error'
}

// A 200 that is JSON but no bid, such as `{}`, is as useless as one that is not JSON.
function isBid(value: unknown): value is BidResponse {
  const bid = value as Partial<BidResponse> | null
  return (
    typeof bid === 'object' &&
    bid !== null &&
    typeof bid.price === 'number' &&
    Number.isFinite(bid.price) &&
    typeof bid.adm === 'string'
  )
}

/** One DSP the exchange calls: its client, its guarded bid, and what became of its bids so far. */
export class DSP {
  readonly id: string
  readonly api: DSPAPI
  /** What the DSP is told it has to answer: its time limit, in milliseconds. */
  readonly tmax: number
  readonly #client: FetchyClient
  readonly #registry: ResilienceRegistry
  readonly #bid: Operation<BidResult, BidRequest>
  readonly #outcomes = new Map<Outcome, number>(OUTCOMES.map(outcome => [outcome, 0]))

  constructor(config: DSPConfig, registry: ResilienceRegistry, guarded: boolean) {
    this.id = config.id
    this.#registry = registry
    this.tmax = registry.timeLimiter(config.id).timeoutDuration
    this.#client = newClient()
      .baseURL(config.url)
      // One connection per call the bulkhead lets through, so no call waits for a socket.
      .transportFactory(
        new UndiciTransportFactory({ connections: registry.bulkhead(config.id).metrics().maxAllowedConcurrentCalls }),
      )
      .build()
    this.api = this.#client.create(DSPAPI)

    const id = this.id
    const call: Operation<BidResult, BidRequest> = async (ctx, request) => {
      const bid = await this.api.bid(request, ctx.signal)
      if (bid === undefined) {
        return { dsp: id, outcome: 'no_bid' }
      }
      if (!isBid(bid)) {
        throw new TypeError(`DSP "${id}" answered a bid with no numeric price or no markup`)
      }
      return { dsp: id, outcome: 'bid', bid }
    }

    if (!guarded) {
      // The baseline: no deadline, no breaker, nothing to stop a DSP from holding the auction. A failure is still a
      // missing bid rather than a failed auction, so the comparison is about time alone.
      this.#bid = (ctx, request) =>
        call(ctx, request).catch((error: unknown) => ({ dsp: id, outcome: outcomeOf(error) }))
      return
    }

    // The order the annotations use, outermost first: the fallback answers for the whole call; an open breaker
    // refuses before the quota is spent; the time limit bounds the wait for a bulkhead slot too.
    const policies: PolicyLike[] = [registry.circuitBreaker(id)]
    if (registry.has(id, 'rateLimiter')) {
      policies.push(registry.rateLimiter(id))
    }
    policies.push(registry.timeLimiter(id), registry.bulkhead(id))

    const noBid = fallback((error): BidResult => ({ dsp: id, outcome: outcomeOf(error) }), { name: id })
    this.#bid = compose(noBid, ...policies)(call)
  }

  /** The DSP's answer to one auction. Resolves with a bid or a reason for none; rejects only when `signal` aborts. */
  async bid(request: BidRequest, signal: AbortSignal): Promise<BidResult> {
    const result = await this.#bid({ signal }, request)
    this.#outcomes.set(result.outcome, (this.#outcomes.get(result.outcome) ?? 0) + 1)
    return result
  }

  /** Where the DSP's policies stand, and how many auctions ended in each outcome since the application started. */
  status(): DSPStatus {
    const registry = this.#registry
    return {
      id: this.id,
      state: registry.circuitBreaker(this.id).state,
      outcomes: Object.fromEntries(this.#outcomes) as Record<Outcome, number>,
      circuitBreaker: registry.circuitBreaker(this.id).metrics(),
      bulkhead: registry.bulkhead(this.id).metrics(),
      rateLimiter: registry.has(this.id, 'rateLimiter') ? registry.rateLimiter(this.id).metrics() : null,
    }
  }

  close(): Promise<void> {
    return this.#client.close()
  }
}

/**
 * Every DSP of `dsps` in the configuration, each with its own client and its own policies: the preset named after
 * its id, which `Resilience()` built. Built once, when the container first asks for it.
 */
@Injectable([kConfig, ResilienceRegistry, logToken()])
export class DSPFleet implements OnDestroy {
  readonly dsps: readonly DSP[]

  constructor(config: Config, registry: ResilienceRegistry, log: Logger) {
    this.dsps = config.dsps.map(dsp => new DSP(dsp, registry, config.exchange.resilience))

    // One listener on the one event worth a log line. Listening to every event would build an event object on every
    // call of every DSP.
    for (const { id } of this.dsps) {
      registry.circuitBreaker(id).on('stateChange', ({ name, from, to }) => {
        log.warn({ dsp: name, from, to }, `DSP "${name}" circuit breaker moved from ${from} to ${to}`)
      })
    }
  }

  /** The DSP with this id. */
  get(id: string): DSP | undefined {
    return this.dsps.find(dsp => dsp.id === id)
  }

  async onDestroy(): Promise<void> {
    await Promise.all(this.dsps.map(dsp => dsp.close()))
  }
}
