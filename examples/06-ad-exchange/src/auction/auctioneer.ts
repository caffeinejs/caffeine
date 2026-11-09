import { randomUUID } from 'node:crypto'

import { Injectable } from '@caffeinejs/di'

import { DSPFleet } from '../dsps/dsp.fleet.js'
import type { BidRequest, BidResponse } from '../dsps/dsp.schemas.js'
import type { AdRequest, AdResponse } from './auction.schemas.js'

/**
 * Runs one first-price auction: every DSP is asked at once, and the highest bid at or above the floor wins at its own
 * price. Two equal bids go to the DSP listed first in `dsps`.
 *
 * Each DSP resolves with a bid or a reason for none, within its own time limit, so the auction never waits on a DSP
 * past that limit and never fails because of one.
 */
@Injectable([DSPFleet])
export class Auctioneer {
  constructor(private readonly fleet: DSPFleet) {}

  /** The winning bid, or `undefined` when none reached the floor. Rejects only when `signal` aborts. */
  async run(ad: AdRequest, signal: AbortSignal): Promise<AdResponse | undefined> {
    const auctionID = randomUUID()
    const results = await Promise.all(
      this.fleet.dsps.map(dsp => {
        const request: BidRequest = {
          id: auctionID,
          tmax: dsp.tmax,
          imp: { id: ad.slot.id, w: ad.slot.w, h: ad.slot.h, bidfloor: ad.floor },
          site: ad.site,
          ...(ad.user === undefined ? {} : { user: ad.user }),
        }
        return dsp.bid(request, signal)
      }),
    )

    let winner: { dsp: string; bid: BidResponse } | undefined
    let bids = 0
    for (const { dsp, bid } of results) {
      if (bid === undefined || bid.price < ad.floor) {
        continue
      }
      bids++
      if (winner === undefined || bid.price > winner.bid.price) {
        winner = { dsp, bid }
      }
    }

    if (winner === undefined) {
      return undefined
    }
    return { auctionID, winner: { dsp: winner.dsp, price: winner.bid.price, adm: winner.bid.adm }, bids }
  }
}
