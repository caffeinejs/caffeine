import { Hour } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BidRequest, DSPStatus } from '../dsps/dsp.schemas.js'
import { bid, type FakeDSP, NO_BID, startDSP } from '../util/testing/dsp.js'
import { AD, auction, dsps, type Exchange, startExchange, type TestDSP } from '../util/testing/exchange.js'

// Every auction against fake DSPs on real sockets, with the `test` profile: a breaker opens after 4 failed calls of
// 4, a bulkhead holds 2 calls, and a rate limiter's period and the deadline are an hour.

let exchange: Exchange | undefined
const fakes: FakeDSP[] = []

async function fleet(n: number): Promise<FakeDSP[]> {
  const started = await Promise.all(Array.from({ length: n }, () => startDSP()))
  fakes.push(...started)
  return started
}

function named(...started: FakeDSP[]): TestDSP[] {
  return started.map((dsp, i) => ({ id: `dsp-${i + 1}`, dsp }))
}

async function status(id: string): Promise<DSPStatus> {
  const found = exchange === undefined ? undefined : (await dsps(exchange)).find(dsp => dsp.id === id)
  if (found === undefined) {
    throw new Error(`no DSP "${id}" in /dsps`)
  }
  return found
}

afterEach(async () => {
  vi.useRealTimers()
  // Held requests are released first, so the exchange's shutdown does not wait on them.
  for (const fake of fakes) {
    fake.release(NO_BID)
  }
  await exchange?.app.close()
  exchange = undefined
  await Promise.all(fakes.splice(0).map(fake => fake.close()))
})

describe('the auction', () => {
  it('sells the slot to the highest bid at or above the floor, at that bid', async () => {
    const [a, b, c] = await fleet(3)
    a.setDefault('/bid', bid(1.5))
    b.setDefault('/bid', bid(2.25))
    c.setDefault('/bid', bid(0.5)) // under the floor of 1
    exchange = await startExchange(named(a, b, c))

    const res = await auction(exchange)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { winner: { dsp: string; price: number; adm: string }; bids: number }
    expect(body.winner).toEqual({ dsp: 'dsp-2', price: 2.25, adm: '<img src="https://ads.test/2.25.png">' })
    expect(body.bids).toBe(2)
  })

  it('answers 204 when no bid reaches the floor', async () => {
    const [a, b] = await fleet(2)
    a.setDefault('/bid', bid(0.99))
    exchange = await startExchange(named(a, b))

    const res = await auction(exchange)

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  // The deadline is what keeps a dead DSP from holding every auction: the others' best bid still wins, and the
  // request to the dead one is closed rather than left to pile up.
  it('answers without a DSP that never answers, and closes the request it left', async () => {
    const [alive, dead] = await fleet(2)
    alive.setDefault('/bid', bid(1.5))
    dead.setDefault('/bid', 'hang')
    // The dead DSP alone has a deadline, so the clock this test drives decides nothing else.
    exchange = await startExchange(
      [
        { id: 'dsp-alive', dsp: alive },
        { id: 'dsp-dead', dsp: dead },
      ],
      { resilience: { presets: { 'dsp-dead': { timeLimiter: { timeoutDuration: '80ms' } } } } },
    )
    // Faked after the file's first fetch, so the clock fetch builds on first use stays real.
    await dsps(exchange)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const pending = auction(exchange)
    await dead.arrived('/bid', 1)
    await vi.advanceTimersByTimeAsync(80)
    const res = await pending

    expect(res.status).toBe(200)
    expect(((await res.json()) as { winner: { dsp: string } }).winner.dsp).toBe('dsp-alive')
    await dead.abandoned(1)
    expect((await status('dsp-dead')).outcomes.timeout).toBe(1)
  })

  it.each([
    ['answers 500', { status: 500, body: { error: 'boom' } }],
    ['resets the connection', 'reset'],
    ['answers 200 with a body that is not JSON', 'malformed'],
    ['answers 200 with JSON that is no bid', { status: 200, body: { ok: true } }],
  ] as const)('counts a DSP that %s as an error, and sells to the others', async (_, reply) => {
    const [good, bad] = await fleet(2)
    good.setDefault('/bid', bid(1.5))
    bad.setDefault('/bid', reply)
    exchange = await startExchange([
      { id: 'dsp-good', dsp: good },
      { id: 'dsp-bad', dsp: bad },
    ])

    const res = await auction(exchange)

    expect(res.status).toBe(200)
    expect(((await res.json()) as { winner: { dsp: string } }).winner.dsp).toBe('dsp-good')
    expect((await status('dsp-bad')).outcomes.error).toBe(1)
  })

  it('stops calling a DSP once its breaker opens, and says so on /dsps', async () => {
    const [good, failing] = await fleet(2)
    good.setDefault('/bid', bid(1.5))
    failing.setDefault('/bid', { status: 503 })
    exchange = await startExchange([
      { id: 'dsp-good', dsp: good },
      { id: 'dsp-failing', dsp: failing },
    ])

    for (let i = 0; i < 7; i++) {
      expect((await auction(exchange)).status).toBe(200)
    }

    // 4 failures of 4 calls open it; the next 3 auctions never reach the DSP.
    expect(failing.count('/bid')).toBe(4)
    const failed = await status('dsp-failing')
    expect(failed.state).toBe('open')
    expect(failed.outcomes.error).toBe(4)
    expect(failed.outcomes.circuit_open).toBe(3)
    expect(good.count('/bid')).toBe(7)
  })

  it('sends a DSP no more requests than the qps it agreed to', async () => {
    const [capped, open] = await fleet(2)
    capped.setDefault('/bid', bid(2))
    open.setDefault('/bid', bid(1.5))
    exchange = await startExchange([
      { id: 'dsp-capped', dsp: capped, qps: 2 },
      { id: 'dsp-open', dsp: open },
    ])

    const winners: string[] = []
    for (let i = 0; i < 5; i++) {
      const res = await auction(exchange)
      winners.push(((await res.json()) as { winner: { dsp: string } }).winner.dsp)
    }

    // The period is an hour in the test profile: 2 permits, then the other DSP wins.
    expect(capped.count('/bid')).toBe(2)
    expect(winners).toEqual(['dsp-capped', 'dsp-capped', 'dsp-open', 'dsp-open', 'dsp-open'])
    expect((await status('dsp-capped')).outcomes.rate_limited).toBe(3)
    expect((await status('dsp-open')).rateLimiter).toBe(null)
  })

  it('holds no more calls to one DSP than its bulkhead allows, and refuses the rest at once', async () => {
    const [good, slow] = await fleet(2)
    good.setDefault('/bid', bid(1.5))
    // The test profile's hour-long deadline keeps both slots taken while the third auction runs.
    slow.setDefault('/bid', 'hang')
    exchange = await startExchange([
      { id: 'dsp-good', dsp: good },
      { id: 'dsp-slow', dsp: slow },
    ])

    const first = auction(exchange)
    const second = auction(exchange)
    await slow.arrived('/bid', 2)
    const third = await auction(exchange)

    expect(third.status).toBe(200)
    expect(slow.peakInFlight).toBe(2)
    expect((await status('dsp-slow')).outcomes.bulkhead_full).toBe(1)

    slow.release(NO_BID)
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect(slow.count('/bid')).toBe(2)
  })

  it('answers 204, never a 5xx, when every DSP fails', async () => {
    const [a, b, c] = await fleet(3)
    a.setDefault('/bid', { status: 500 })
    b.setDefault('/bid', 'reset')
    c.setDefault('/bid', 'malformed')
    exchange = await startExchange(named(a, b, c))

    const res = await auction(exchange)

    expect(res.status).toBe(204)
  })

  it('refuses an ad request without a slot, and calls no DSP', async () => {
    const [a] = await fleet(1)
    exchange = await startExchange(named(a))

    const res = await auction(exchange, { floor: 1, site: { domain: 'news.test' } })

    expect(res.status).toBe(400)
    expect(a.count('/bid')).toBe(0)
  })

  it("tells each DSP its deadline and the publisher's floor", async () => {
    const [a] = await fleet(1)
    exchange = await startExchange(named(a))

    await auction(exchange, { ...AD, floor: 1.75, user: { id: 'u-1' } })

    const sent = a.arrivals[0]?.body as BidRequest
    // The test profile's deadline, in milliseconds.
    expect(sent.tmax).toBe(1 * Hour)
    expect(sent.imp).toEqual({ id: 'slot-1', w: 300, h: 250, bidfloor: 1.75 })
    expect(sent.site).toEqual({ domain: 'news.test' })
    expect(sent.user).toEqual({ id: 'u-1' })
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  // An ad server that gives up on the exchange takes every bid request with it: no DSP keeps working for nobody.
  it('stops every bid request when the client leaves', async () => {
    const [a, b] = await fleet(2)
    a.setDefault('/bid', 'hang')
    b.setDefault('/bid', 'hang')
    exchange = await startExchange(named(a, b))

    const client = new AbortController()
    const pending = auction(exchange, AD, client.signal)
    await Promise.all([a.arrived('/bid', 1), b.arrived('/bid', 1)])
    client.abort()

    await expect(pending).rejects.toThrow()
    await Promise.all([a.abandoned(1), b.abandoned(1)])
  })

  // The baseline the load test compares against: with no policy, the auction waits for the slowest DSP.
  it('waits for a held DSP when resilience is off', async () => {
    const [fast, held] = await fleet(2)
    fast.setDefault('/bid', bid(1.5))
    held.setDefault('/bid', 'hang')
    exchange = await startExchange(
      [
        { id: 'dsp-fast', dsp: fast },
        { id: 'dsp-held', dsp: held },
      ],
      // A deadline a guarded exchange would pass before the held DSP even saw the request.
      { exchange: { resilience: false }, resilience: { defaults: { timeLimiter: { timeoutDuration: '1ms' } } } },
    )

    const pending = auction(exchange)
    await Promise.all([held.arrived('/bid', 1), fast.arrived('/bid', 1)])

    // The held DSP wins only if the auction is still waiting for it when it answers.
    held.release(bid(3))
    const res = await pending
    expect(((await res.json()) as { winner: { dsp: string } }).winner.dsp).toBe('dsp-held')
  })
})
