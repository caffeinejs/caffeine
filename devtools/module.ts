import { mod, type Module } from '@caffeinejs/di'
import { ContainerCollector } from './collectors/container.collector.js'
import { DevtoolsServer, type DevtoolsOptions } from './server/server.js'

export function DevtoolsModule(options: DevtoolsOptions = {}): Module {
  return mod('DevtoolsModule', container => {
    const server = new DevtoolsServer(options)

    container.bind(DevtoolsServer, t => t.toValue(server))

    const collector = new ContainerCollector(
      container.hooks,
      server._store,
      event => server.broadcast(event),
    )

    collector.attach(() => container.entries())
    collector.backfill(container.entries())
  })
}
