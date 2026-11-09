import { Controller, type IContext, Post, Schema } from '@caffeinejs/http'

import { WinNotifier } from '../wins/win.notifier.js'
import { type AdRequest, AdRequestSchema, type AdResponse } from './auction.schemas.js'
import { Auctioneer } from './auctioneer.js'

@Controller('/ad', [Auctioneer, WinNotifier])
export class AuctionController {
  constructor(
    private readonly auctioneer: Auctioneer,
    private readonly wins: WinNotifier,
  ) {}

  // The request's signal aborts when the client leaves, which stops every bid request still in flight.
  @Post('/', p => [p.body(), p.signal(), p.context()])
  @Schema({ body: AdRequestSchema })
  async auction(ad: AdRequest, signal: AbortSignal, ctx: IContext): Promise<AdResponse | undefined> {
    const result = await this.auctioneer.run(ad, signal)
    if (result === undefined) {
      ctx.status(204)
      return undefined
    }

    // After the answer is decided, and never awaited: the client gets its ad while the DSP is told it won.
    this.wins.send(result.winner.dsp, { id: result.auctionID, price: result.winner.price })
    return result
  }
}
