import { afterEach, describe, expect, it } from 'vitest'

import type { WinNotice } from '../dsps/dsp.schemas.js'
import { bid, type FakeDSP, NO_BID, startDSP } from '../util/testing/dsp.js'
import { auction, type Exchange, startExchange } from '../util/testing/exchange.js'

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
})
