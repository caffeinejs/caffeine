import { describe, expect, it } from 'vitest'

import type { Outcome } from '../src/dsps/dsp.schemas.js'
import { measure, type Measured, verdict } from './verdict.js'

// The checks the load script fails a run on, against results shaped as autocannon reports them.

const NONE: Record<Outcome, number> = {
  bid: 0,
  no_bid: 0,
  timeout: 0,
  circuit_open: 0,
  rate_limited: 0,
  bulkhead_full: 0,
  error: 0,
}

/** The dead DSP's breaker refused every one of its auctions. */
const REFUSED = new Map([['dsp-dead', { ...NONE, circuit_open: 400 }]])

/** A run of 400 auctions within every budget: 392 sold, 8 answered `other`. */
function result(other: Record<string, number> = { '204': 8 }, overrides: Partial<Measured> = {}): Measured {
  const statuses = { '200': 392, ...other }
  const total = Object.values(statuses).reduce((sum, count) => sum + count, 0)
  return {
    latency: { p99: 80 },
    requests: { total },
    errors: 0,
    timeouts: 0,
    statusCodeStats: Object.fromEntries(Object.entries(statuses).map(([status, count]) => [status, { count }])),
    ...overrides,
  }
}

function failures(measured: Measured, outcomes = REFUSED): string[] {
  return verdict(measured, measure(measured, outcomes))
}

describe('the load test verdict', () => {
  // A 204 is an auction nothing won, which the fill budget answers for; no other status is an answer an ad server reads.
  it.each(['201', '202', '206', '500'])('fails a run with any status other than 200 or 204, such as %s', status => {
    expect(failures(result({ [status]: 8 }))).toEqual([`8 auctions answered ${status}`])
  })

  // An exchange that never answered must not pass for one that sold nothing wrong: every share reads as zero.
  it('fails a run in which no auction was answered', () => {
    const silent: Measured = { latency: { p99: 0 }, requests: { total: 0 }, errors: 64, timeouts: 64 }

    expect(failures(silent, new Map())).toEqual([
      '64 requests failed',
      '0.0% of the auctions sold, under the 95.0% budget',
      "the dead DSP's breaker refused 0.0% of its auctions, under 90.0%",
    ])
  })

  it('passes a run of 200s and 204s within every budget', () => {
    expect(failures(result())).toEqual([])
  })

  it.each([
    ['a p99 over budget', result(undefined, { latency: { p99: 101 } }), [], 'p99 is 101ms, over the 100ms budget'],
    ['failed requests', result(undefined, { errors: 3 }), [], '3 requests failed'],
    ['too few sales', result({ '204': 40 }), [], '90.7% of the auctions sold, under the 95.0% budget'],
    [
      'a dead DSP its breaker let through',
      result(),
      [['dsp-dead', { ...NONE, circuit_open: 300, timeout: 100 }]],
      "the dead DSP's breaker refused 75.0% of its auctions, under 90.0%",
    ],
  ] as const)('names %s', (_name, measured, dead, reason) => {
    const outcomes = dead.length === 0 ? REFUSED : new Map(dead)
    expect(failures(measured, outcomes)).toEqual([reason])
  })
})
