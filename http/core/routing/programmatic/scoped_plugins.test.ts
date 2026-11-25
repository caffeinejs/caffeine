import { newNoopLogger } from '@caffeinejs/application/logger'
import type { Container } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { HTTPPlugin, type HTTPSetupContext } from '../../../plugin.js'
import { PluginSlot, type SlotIdentity } from '../../../plugin_slot.js'
import { HookBatch } from '../../lifecycle/batch.js'
import { Router } from './programmatic.js'
import { ScopedPlugins } from './scoped_plugins.js'
import { stateOf } from './state.js'

/** The server every scope belongs to. */
const identity: SlotIdentity = { name: undefined, basePath: '', router: undefined, address: () => undefined }

const server = new PluginSlot()
server.forServer(identity)

const context: HTTPSetupContext = {
  container: {} as Container,
  config: {} as never,
  store: {} as never,
  logger: newNoopLogger(),
  hasFeature: () => false,
  server,
}

class Hooking extends HTTPPlugin {
  constructor(readonly hook: () => void) {
    super()
  }

  register({ server }: HTTPSetupContext): void {
    server.hook('onRequest', this.hook)
  }
}

describe('ScopedPlugins', () => {
  it("records a router plugin's hooks under the router, in its place among the router's plugins", async () => {
    const first = (): void => undefined
    const second = (): void => undefined
    const router = new Router('/r').with(() => new Hooking(first)).with(() => new Hooking(second))
    const plugins = new ScopedPlugins(server, identity)

    await plugins.resolveRouters([router], context)

    const batches = plugins.batchesOf([{ key: stateOf(router)!, path: '/r' }], 0)
    expect(batches.every(entry => entry instanceof HookBatch)).toBe(true)
    expect(batches.map(batch => batch.request.onRequest)).toEqual([[first], [second]])
  })

  // Each place a router is mounted at is one registration: what its plugins add there covers that place alone.
  it('registers a router mounted at two places once per place', async () => {
    const seen: string[] = []
    const shared = new Router('/s').with(() => {
      return new (class extends HTTPPlugin {
        register({ server: scoped }: HTTPSetupContext): void {
          seen.push(scoped.prefix)
        }
      })()
    })
    const plugins = new ScopedPlugins(server, identity)

    await plugins.resolveRouters([new Router('/a').mount(shared), new Router('/b').mount(shared)], context)

    expect(seen).toEqual(['/a/s', '/b/s'])
  })
})
