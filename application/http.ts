import type { Adapter, AdapterFactory } from './application.js'
import { WebApplicationBuilder, type WebApplicationOptions } from './builder.js'

export { type WebApplicationOptions }

export function createWebApplication<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>>(
  adapterFactory: AdapterFactory<I, REQ, A>,
  options: WebApplicationOptions = {},
): WebApplicationBuilder<I, REQ, A> {
  return new WebApplicationBuilder(adapterFactory, options)
}
