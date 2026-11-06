import type { Logger } from '@caffeinejs/application/logger'
import { logToken } from '@caffeinejs/application/logger'
import { Injectable } from '@caffeinejs/di'
import { ErrFetchyHTTP } from '@caffeinejs/fetchy'
import { ResilienceContext, Resilient } from '@caffeinejs/resilience/aop'

import { WIN_NOTICE } from '../app.config.js'
import { DSPFleet } from '../dsps/dsp.fleet.js'
import type { WinNotice } from '../dsps/dsp.schemas.js'

/**
 * Tells the winning DSP it won. The DSP bills on it, so a failed notice is tried again, with the retry and the time
 * limit of preset `win-notice`; nobody waits for it, so the retries cost the auction nothing.
 *
 * No caller has a signal to pass, so each attempt's signal, which the time limit aborts, is read from the
 * `ResilienceContext` that `r.context(...)` in `app.ts` enables.
 */
@Injectable([DSPFleet, ResilienceContext, logToken()])
export class WinNotifier {
  constructor(
    private readonly fleet: DSPFleet,
    private readonly attempt: ResilienceContext,
    private readonly log: Logger,
  ) {}

  /** Sends the notice in the background and logs it when every attempt failed. Never rejects. */
  send(dsp: string, notice: WinNotice): void {
    this.notify(dsp, notice).catch((error: unknown) => {
      this.log.error({ dsp, auction: notice.id, err: error }, `DSP "${dsp}" was not told it won auction ${notice.id}`)
    })
  }

  @Resilient(WIN_NOTICE)
  async notify(dsp: string, notice: WinNotice): Promise<void> {
    const target = this.fleet.get(dsp)
    if (target === undefined) {
      throw new RangeError(`No DSP has the id "${dsp}"`)
    }
    await target.api.win(notice, this.attempt.signal)
  }
}

/**
 * Whether a failed win notice is worth another attempt. A 4xx is the DSP refusing this notice, and it would refuse
 * the same one again; anything else, a 5xx, a reset or a timeout, may pass the next time.
 */
export function retryWinNotice(error: unknown): boolean {
  return !(error instanceof ErrFetchyHTTP && error.status >= 400 && error.status < 500)
}
