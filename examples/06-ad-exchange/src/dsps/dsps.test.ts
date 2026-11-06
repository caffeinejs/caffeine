import { Hour } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { bid, type FakeDSP, NO_BID, startDSP } from '../util/testing/dsp.js'
import { auction, dsps, type Exchange, startExchange } from '../util/testing/exchange.js'
import type { BidRequest } from './dsp.schemas.js'

// GET /dsps and each DSP's own policies, against fake DSPs on real sockets, with the `test` profile.

let exchange: Exchange | undefined
const fakes: FakeDSP[] = []

async function fleet(n: number): Promise<FakeDSP[]> {
  const started = await Promise.all(Array.from({ length: n }, () => startDSP()))
  fakes.push(...started)
  return started
}

afterEach(async () => {
  for (const fake of fakes) {
    fake.release(NO_BID)
  }
  await exchange?.app.close()
  exchange = undefined
  await Promise.all(fakes.splice(0).map(fake => fake.close()))
})

describe('GET /dsps', () => {
  // What an operator reads to see which DSP is costing bids, and why.
  it('lists every DSP in the order of the configuration, with what became of its bids', async () => {
    const [bidding, passing, failing] = await fleet(3)
    bidding.setDefault('/bid', bid(1.5))
    failing.setDefault('/bid', { status: 500 })
    exchange = await startExchange([
      { id: 'dsp-bidding', dsp: bidding },
      { id: 'dsp-passing', dsp: passing },
      { id: 'dsp-failing', dsp: failing, qps: 10 },
    ])

    await auction(exchange)
    await auction(exchange)

    const listed = await dsps(exchange)
    expect(listed.map(dsp => [dsp.id, dsp.state, dsp.outcomes])).toEqual([
      [
        'dsp-bidding',
        'closed',
        { bid: 2, no_bid: 0, timeout: 0, circuit_open: 0, rate_limited: 0, bulkhead_full: 0, error: 0 },
      ],
      [
        'dsp-passing',
        'closed',
        { bid: 0, no_bid: 2, timeout: 0, circuit_open: 0, rate_limited: 0, bulkhead_full: 0, error: 0 },
      ],
      [
        'dsp-failing',
        'closed',
        { bid: 0, no_bid: 0, timeout: 0, circuit_open: 0, rate_limited: 0, bulkhead_full: 0, error: 2 },
      ],
    ])
    expect(listed[2]?.circuitBreaker.failedCalls).toBe(2)
    expect(listed[2]?.bulkhead.maxAllowedConcurrentCalls).toBe(2)
    expect(listed[2]?.rateLimiter?.availablePermissions).toBe(8)
    expect(listed[0]?.rateLimiter).toBe(null)
  })
})

describe('a DSP whose breaker is open', () => {
  // One DSP down is a missing bid, not an exchange that cannot serve: taking the exchange out of the load balancer
  // would lose every auction.
  it('leaves the exchange ready', async () => {
    const [good, failing] = await fleet(2)
    good.setDefault('/bid', bid(1.5))
    failing.setDefault('/bid', { status: 503 })
    exchange = await startExchange([
      { id: 'dsp-good', dsp: good },
      { id: 'dsp-failing', dsp: failing },
    ])

    for (let i = 0; i < 4; i++) {
      await auction(exchange)
    }
    expect((await dsps(exchange))[1]?.state).toBe('open')

    const res = await fetch(`${exchange.origin}/readyz`)

    expect(res.status).toBe(200)
  })
})

describe("a DSP's own preset", () => {
  // A DSP that agreed to a shorter deadline is told so, and held to it, while the others keep the default.
  it('wins over the defaults, for that DSP alone', async () => {
    const [a, b] = await fleet(2)
    exchange = await startExchange(
      [
        { id: 'dsp-1', dsp: a },
        { id: 'dsp-2', dsp: b },
      ],
      { resilience: { presets: { 'dsp-2': { timeLimiter: { timeoutDuration: '20ms' } } } } },
    )

    await auction(exchange)

    const [toA, toB] = [a.arrivals[0]?.body, b.arrivals[0]?.body] as Array<BidRequest | undefined>
    expect(toA?.tmax).toBe(1 * Hour)
    expect(toB?.tmax).toBe(20)
  })
})
