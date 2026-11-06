import { InlineConfigSource } from '@caffeinejs/application/config/inline'

import { configuration } from '../../app.config.js'
import { createContainer } from '../../app.container.js'
import { type AdExchangeApp, buildApp } from '../../app.js'
import type { AdRequest } from '../../auction/auction.schemas.js'
import type { DSPStatus } from '../../dsps/dsp.schemas.js'
import { rootModule } from '../../root.gen.mod.js'
import type { FakeDSP } from './dsp.js'

/** One DSP the exchange under test calls: a fake one, with the `qps` it agreed to, if any. */
export interface TestDSP {
  readonly id: string
  readonly dsp: FakeDSP
  readonly qps?: number
}

/** The running exchange, and the origin a client reaches it at. */
export interface Exchange {
  readonly app: AdExchangeApp
  readonly origin: string
}

/**
 * Starts the whole application on a real socket, `test` profile, calling `dsps` and nothing else. `overrides` is
 * layered over the configuration last, as any later source would be.
 */
export async function startExchange(
  dsps: readonly TestDSP[],
  overrides: Record<string, unknown> = {},
): Promise<Exchange> {
  const source = new InlineConfigSource({
    dsps: dsps.map(({ id, dsp, qps }) => (qps === undefined ? { id, url: dsp.origin } : { id, url: dsp.origin, qps })),
    ...overrides,
  })
  const app = buildApp(createContainer(rootModule), {
    logger: false,
    config: { ...configuration, sources: [...configuration.sources, source] },
  })
  const { address } = await app.run()
  return { app, origin: address.origin }
}

export const AD: AdRequest = {
  slot: { id: 'slot-1', w: 300, h: 250 },
  floor: 1,
  site: { domain: 'news.test' },
}

/** `POST /ad` with `ad`, over the socket, as an ad server would send it. */
export function auction(exchange: Exchange, ad: unknown = AD, signal?: AbortSignal): Promise<Response> {
  return fetch(`${exchange.origin}/ad`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ad),
    signal,
  })
}

/** `GET /dsps`: every DSP's policies and outcomes, in the order of the configuration. */
export async function dsps(exchange: Exchange): Promise<DSPStatus[]> {
  const res = await fetch(`${exchange.origin}/dsps`)
  return ((await res.json()) as { dsps: DSPStatus[] }).dsps
}
