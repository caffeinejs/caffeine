import type { Transport, TransportFactory } from '../../transport.js'
import { FetchTransport } from './fetch_transport.js'

/**
 * Default {@link TransportFactory}, used automatically by `FetchyBuilder.build()` when no explicit
 * `.transportFactory()` was configured.
 */
export class FetchTransportFactory implements TransportFactory {
  provide(_baseURL: string): Transport {
    return new FetchTransport()
  }
}
