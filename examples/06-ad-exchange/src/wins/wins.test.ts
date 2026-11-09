import { afterEach, describe, expect, it } from 'vitest'

import type { WinNotice } from '../dsps/dsp.schemas.js'
import { bid, type FakeDSP, NO_BID, startDSP } from '../util/testing/dsp.js'
import { auction, type Exchange, startExchange } from '../util/testing/exchange.js'
import { WinNotifier } from './win.notifier.js'

// Win notices, against fake DSPs on real sockets, with the `test` profile: 4 attempts, 1ms apart.

let exchange: Exchange | undefined
const fakes: FakeDSP[] = []

async function sale(): Promise<{ winner: FakeDSP; loser: FakeDSP }> {
  const [winner, loser] = await Promise.all([startDSP(), startDSP()])
  fakes.push(winner, loser)
  winner.setDefault('/bid', bid(2))
  loser.setDefault('/bid', bid(1.5))
  exchange = await startExchange([
    { id: 'dsp-winner', dsp: winner },
    { id: 'dsp-loser', dsp: loser },
  ])
  return { winner, loser }
}

async function sold(): Promise<string> {
  const res = await auction(exchange as Exchange)
  return ((await res.json()) as { auctionID: string }).auctionID
}

afterEach(async () => {
  for (const fake of fakes) {
    fake.release(NO_BID)
  }
  await exchange?.app.close()
  exchange = undefined
  await Promise.all(fakes.splice(0).map(fake => fake.close()))
})

describe('the win notice', () => {
  // The DSP bills on it, and the ad server waits for none of it.
  it('tells the winner alone what it pays, without holding the answer', async () => {
    const { winner, loser } = await sale()
    winner.setDefault('/win', 'hang')

    const id = await sold()
    await winner.arrived('/win', 1)

    const notices = winner.arrivals.filter(arrival => arrival.path === '/win').map(arrival => arrival.body)
    expect(notices).toEqual([{ id, price: 2 } satisfies WinNotice])
    expect(loser.count('/win')).toBe(0)
  })

  it('is sent again after a 5xx, until the DSP takes it', async () => {
    const { winner } = await sale()
    winner.script('/win', { status: 503 }, { status: 503 }, { status: 200 })

    const id = await sold()
    await winner.arrived('/win', 3)

    const notices = winner.arrivals.filter(arrival => arrival.path === '/win').map(arrival => arrival.body)
    expect(notices).toEqual([
      { id, price: 2 },
      { id, price: 2 },
      { id, price: 2 },
    ])
  })

  // A 4xx is the DSP refusing this notice: it would refuse the same one again.
  it('is not sent again after a 4xx', async () => {
    const { winner } = await sale()
    winner.script('/win', { status: 400 })

    const first = await sold()
    await winner.arrived('/win', 1)
    // A retry of the first, 1ms later, would reach the DSP before the next auction's notice does.
    const second = await sold()
    await winner.arrived('/win', 2)

    const notices = winner.arrivals.filter(arrival => arrival.path === '/win').map(arrival => arrival.body)
    expect(notices).toEqual([
      { id: first, price: 2 },
      { id: second, price: 2 },
    ])
  })

  // A notice the DSP holds must not keep the next auction from reaching that same DSP: the bulkhead counts bids alone,
  // and its connections were sized for them. The `test` profile gives the DSP two.
  it('leaves the bid connections free while its notices hang', async () => {
    const dsp = await startDSP()
    fakes.push(dsp)
    dsp.setDefault('/bid', bid(2))
    dsp.setDefault('/win', 'hang')
    // Every notice keeps its connection for as long as the DSP holds it.
    exchange = await startExchange([{ id: 'dsp-busy', dsp }], {
      resilience: { presets: { 'win-notice': { timeLimiter: { timeoutDuration: '1h' } } } },
    })
    await sold()
    await dsp.arrived('/win', 1)
    await sold()
    await dsp.arrived('/win', 2)

    const res = await auction(exchange)

    expect(await res.json()).toMatchObject({ winner: { dsp: 'dsp-busy', price: 2 } })
    expect(dsp.count('/bid')).toBe(3)
    // The third notice waits for a connection the held ones free at the end; it must not be held in turn.
    dsp.setDefault('/win', { status: 200 })
  })

  // The winner's id comes from the fleet, so only a caller that made one up can name a DSP the fleet does not have.
  it('refuses a notice for a DSP the fleet does not have', async () => {
    await sale()
    const notifier = (exchange as Exchange).app.container.get(WinNotifier)

    await expect(notifier.notify('dsp-unknown', { id: 'a-1', price: 2 })).rejects.toThrow(
      new RangeError('No DSP has the id "dsp-unknown"'),
    )
  })
})
