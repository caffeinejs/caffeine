import { mod, type Module } from '@caffeinejs/di'

import { ContainerCollector } from './collectors/container.collector.js'
import { DevtoolsServer, type DevtoolsOptions } from './server/server.js'

/**
 * Binds a {@link DevtoolsServer} fed with the container's events. Start it yourself; the container stops it when it
 * is disposed, so an application's `close()` leaves no devtools socket open to keep the process alive.
 */
export function DevtoolsModule(options: DevtoolsOptions = {}): Module {
  return mod('DevtoolsModule', container => {
    const server = new DevtoolsServer(options)

    container.bind(DevtoolsServer, t => t.toValue(server).preDestroy(s => s.stop()))

    const collector = new ContainerCollector(container.hooks, server._store, event => server.broadcast(event))

    collector.attach(() => container.entries())
    collector.backfill(container.entries())
  })
}
