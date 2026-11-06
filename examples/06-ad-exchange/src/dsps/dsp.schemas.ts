import type { BulkheadMetrics } from '@caffeinejs/resilience/bulkhead'
import type { CircuitBreakerMetrics, CircuitBreakerState } from '@caffeinejs/resilience/circuitbreaker'
import type { RateLimiterMetrics } from '@caffeinejs/resilience/ratelimiter'

/**
 * What the exchange and a DSP say to each other. Loosely shaped after OpenRTB, and no more of it than the example
 * needs: one impression per request, one bid per answer.
 */

/** `POST /bid`: one impression offered to one DSP. */
export interface BidRequest {
  /** The auction's id, the same for every DSP of one auction. */
  readonly id: string
  /** How long the DSP has to answer, in milliseconds, as OpenRTB writes it. */
  readonly tmax: number
  readonly imp: {
    readonly id: string
    readonly w: number
    readonly h: number
    /** The lowest price, in USD CPM, the exchange accepts. */
    readonly bidfloor: number
  }
  readonly site: { readonly domain: string }
  readonly user?: { readonly id: string }
}

/** A DSP's 200 answer to `POST /bid`. A DSP that passes answers 204 with no body. */
export interface BidResponse {
  /** The auction's id, echoed. */
  readonly id: string
  /** In USD CPM. */
  readonly price: number
  /** The ad markup to render. */
  readonly adm: string
}

/** `POST /win`: the winning DSP is told it won, and at what price. */
export interface WinNotice {
  readonly id: string
  readonly price: number
}

/** What became of one DSP's part in one auction. */
export type Outcome = 'bid' | 'no_bid' | 'timeout' | 'circuit_open' | 'rate_limited' | 'bulkhead_full' | 'error'

export const OUTCOMES: readonly Outcome[] = [
  'bid',
  'no_bid',
  'timeout',
  'circuit_open',
  'rate_limited',
  'bulkhead_full',
  'error',
]

/** One DSP's answer to one auction: a bid, or the reason there is none. */
export interface BidResult {
  readonly dsp: string
  readonly outcome: Outcome
  readonly bid?: BidResponse
}

/** `GET /dsps`: one DSP's policies as they stand, and its outcomes so far. */
export interface DSPStatus {
  readonly id: string
  readonly state: CircuitBreakerState
  readonly outcomes: Readonly<Record<Outcome, number>>
  readonly circuitBreaker: CircuitBreakerMetrics
  readonly bulkhead: BulkheadMetrics
  /** `null` for a DSP that set no `qps`. */
  readonly rateLimiter: RateLimiterMetrics | null
}
