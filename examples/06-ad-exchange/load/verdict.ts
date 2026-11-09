import type autocannon from 'autocannon'

import type { Outcome } from '../src/dsps/dsp.schemas.js'

/** What the run must hold to, unless it is the baseline. */
export const BUDGET = {
  /** An ad server waits about 100ms for its exchange; the 80ms DSP deadline leaves the rest for the exchange itself. */
  p99: 100,
  /** The share of auctions that sell. Every well-behaved DSP bids most auctions, so a lower one means lost bids. */
  fill: 0.95,
  /** The share of the dead DSP's auctions its open breaker refuses without calling it. */
  deadRefused: 0.9,
} as const

/** What autocannon measured, as far as the budget reads it. */
export interface Measured {
  readonly latency: Pick<autocannon.Result['latency'], 'p99'>
  readonly requests: Pick<autocannon.Result['requests'], 'total'>
  readonly errors: number
  readonly timeouts: number
  readonly statusCodeStats?: autocannon.Result['statusCodeStats']
}

/** What became of the auctions of the measured run. */
export interface Run {
  /** Auctions answered 200, with a winner. */
  readonly sold: number
  /** Auctions answered 204, which nothing won. */
  readonly unsold: number
  /** Auctions answered any other status, by status. An exchange answers none: each is a failed auction. */
  readonly others: ReadonlyMap<string, number>
  /** The share of every auction sent that sold, those that timed out included. */
  readonly fill: number
  /** The share of the dead DSP's auctions its open breaker refused. */
  readonly deadRefused: number
}

/** What became of the auctions, from autocannon's result and each DSP's outcomes over the run. */
export function measure(result: Measured, outcomes: ReadonlyMap<string, Record<Outcome, number>>): Run {
  const total = result.requests.total + result.timeouts
  // Not `non2xx`, which counts outside the 2xx class only: a 201 or a 206 is no answer an ad server reads either.
  const counts = Object.entries(result.statusCodeStats ?? {}).map(
    ([status, { count }]) => [status, count ?? 0] as const,
  )
  const sold = counts.find(([status]) => status === '200')?.[1] ?? 0
  const dead = outcomes.get('dsp-dead')
  const deadTotal = dead === undefined ? 0 : Object.values(dead).reduce((sum, count) => sum + count, 0)
  return {
    sold,
    unsold: counts.find(([status]) => status === '204')?.[1] ?? 0,
    others: new Map(counts.filter(([status, count]) => status !== '200' && status !== '204' && count > 0)),
    fill: total === 0 ? 0 : sold / total,
    deadRefused: deadTotal === 0 ? 0 : (dead?.circuit_open ?? 0) / deadTotal,
  }
}

export function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}

/** Each budget the run missed, as a sentence; none when it passed. */
export function verdict(result: Measured, run: Run): string[] {
  return [
    result.latency.p99 > BUDGET.p99 && `p99 is ${result.latency.p99}ms, over the ${BUDGET.p99}ms budget`,
    ...[...run.others].map(([status, count]) => `${count} auctions answered ${status}`),
    result.errors > 0 && `${result.errors} requests failed`,
    run.fill < BUDGET.fill && `${percent(run.fill)} of the auctions sold, under the ${percent(BUDGET.fill)} budget`,
    run.deadRefused < BUDGET.deadRefused &&
      `the dead DSP's breaker refused ${percent(run.deadRefused)} of its auctions, under ${percent(BUDGET.deadRefused)}`,
  ].filter(reason => reason !== false)
}
