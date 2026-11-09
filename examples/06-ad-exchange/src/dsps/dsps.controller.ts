import { Controller, Get } from '@caffeinejs/http'

import { DSPFleet } from './dsp.fleet.js'
import type { DSPStatus } from './dsp.schemas.js'

/** Where every DSP's policies stand, and what became of its bids: what the load script prints at the end. */
@Controller('/dsps', [DSPFleet])
export class DSPsController {
  constructor(private readonly fleet: DSPFleet) {}

  @Get('/')
  list(): { dsps: DSPStatus[] } {
    return { dsps: this.fleet.dsps.map(dsp => dsp.status()) }
  }
}
