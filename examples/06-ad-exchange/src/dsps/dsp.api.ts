import { API, Body, Params, POST, SignalParam } from '@caffeinejs/fetchy'

import type { BidRequest, BidResponse, WinNotice } from './dsp.schemas.js'

/**
 * The two calls the exchange makes to a DSP. `FetchyClient.create(DSPAPI)` fills the fields in, one client per DSP.
 *
 * A 204 converts to `undefined`, a DSP that passes; any other status that is not 2xx rejects with `ErrFetchyHTTP`,
 * and a body that is not JSON rejects from the converter. Nothing here retries: the resilience policies decide that.
 */
@API()
export class DSPAPI {
  @POST('/bid')
  @Params([Body(), SignalParam()])
  bid!: (request: BidRequest, signal?: AbortSignal) => Promise<BidResponse | undefined>

  @POST('/win')
  @Params([Body(), SignalParam()])
  win!: (notice: WinNotice, signal?: AbortSignal) => Promise<void>
}
