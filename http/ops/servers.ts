import type { IAdapterServer, IAdapterTypes } from '../adapter.js'
import type { OpsServer } from './builder.js'

/** The named servers as `app.ops` hands them out: what each is and where it listens, but not its lifecycle. */
export function opsServers<T extends IAdapterTypes>(
  servers: ReadonlyMap<string, IAdapterServer<T>>,
): ReadonlyMap<string, OpsServer<T>> {
  return new Map([...servers].map(([name, server]) => [name, opsServer(name, server)]))
}

function opsServer<T extends IAdapterTypes>(name: string, server: IAdapterServer<T>): OpsServer<T> {
  return {
    name,
    get instance() {
      return server.instance
    },
    get address() {
      return server.address
    },
    fetch: (request, options) => server.fetch(request, options),
  }
}
