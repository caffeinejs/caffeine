import type { IServer } from '../../server.js'
import { viewOf, type HostedServer } from '../server/hosting.js'

/** The listeners as `app.listeners` hands them out: what each is and where it listens, but not its lifecycle. */
export function listenerServers(servers: ReadonlyMap<string, HostedServer>): ReadonlyMap<string, IServer> {
  return new Map([...servers].map(([name, server]) => [name, viewOf(server)]))
}
