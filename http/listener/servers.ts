import type { IAdapterServer, IAdapterTypes } from '../adapter.js'
import type { IServer } from '../server.js'

/** The listeners as `app.listeners` hands them out: what each is and where it listens, but not its lifecycle. */
export function listenerServers<T extends IAdapterTypes>(
  servers: ReadonlyMap<string, IAdapterServer<T>>,
): ReadonlyMap<string, IServer<T>> {
  return new Map([...servers].map(([name, server]) => [name, serverView(server)]))
}

function serverView<T extends IAdapterTypes>(server: IAdapterServer<T>): IServer<T> {
  return {
    get instance() {
      return server.instance
    },
    get address() {
      return server.address
    },
    fetch: (request, options) => server.fetch(request, options),
  }
}
