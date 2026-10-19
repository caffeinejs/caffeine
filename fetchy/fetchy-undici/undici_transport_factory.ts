import type { Transport, TransportFactory } from '@caffeinejs/fetchy'
import { Agent, interceptors, Pool } from 'undici'

import { UndiciTransport } from './undici_transport.js'

// As many redirects as fetch follows.
const MAX_REDIRECTIONS = 20

// A transport over an agent its factory created, so closing the client closes every pool the agent opened. A
// `UndiciTransport` built over a caller's dispatcher has no `close()`, and leaves that dispatcher to the caller.
class AgentTransport extends UndiciTransport {
  constructor(private readonly agent: Agent) {
    super(agent.compose(interceptors.redirect({ maxRedirections: MAX_REDIRECTIONS })))
  }

  close(): Promise<void> {
    return this.agent.close()
  }
}

/**
 * `TransportFactory` that dispatches through an `undici` `Agent`, one per `provide()` call, that is one
 * per `FetchyClient`, which holds a connection-pooling `Pool` for each origin it reaches, built with
 * these options. `FetchyClient.close()` closes them all, once the requests already sent complete.
 *
 * It follows redirects as `fetch` does: up to 20, to any origin. A POST answered 301 or 302, and any
 * method answered 303, is sent again as a GET without its body, and a redirect to another origin drops
 * `authorization`, `cookie` and `proxy-authorization`. The options apply to every origin a redirect
 * reaches but `socketPath` and `connect`: they say how to reach the base URL's origin, and a redirect
 * to another origin connects to the origin it names.
 */
export class UndiciTransportFactory implements TransportFactory {
  constructor(private readonly options?: Pool.Options) {}

  provide(baseURL: string): Transport {
    const base = new URL(baseURL).origin
    const options = this.options
    // A socket, a certificate or a lookup set for the base URL's origin is no way to reach another one.
    const elsewhere = { ...options, socketPath: undefined, connect: undefined }
    // An Agent asks `factory` for the dispatcher of each origin, where a Pool asks it for each connection: each origin
    // gets a pool of its own, so a factory the options name goes on building connections, and is told for which origin.
    const agent = new Agent({
      factory: origin => new Pool(origin, new URL(origin).origin === base ? options : elsewhere),
    })

    return new AgentTransport(agent)
  }
}
