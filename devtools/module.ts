import type { Module } from '@caffeinejs/core'
import { ContainerCollector } from './collectors/container.collector.js'
import { DevtoolsServer, type DevtoolsOptions } from './server/server.js'

export function DevtoolsModule(options: DevtoolsOptions = {}): Module {
  return container => {
    const server = new DevtoolsServer(options)

    container.bind(DevtoolsServer).toValue(server)

    const collector = new ContainerCollector(
      container.hooks,
      server._store,
      event => server.broadcast(event),
    )

    collector.attach(() => container.entries())
    collector.backfill(container.entries())
  }
}
