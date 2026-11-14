import { newNoopLogger } from '@caffeinejs/application/logger'
import type { Container } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import type { HTTPSetupContext } from '../../../adapter.js'
import { HTTPPlugin } from '../../../plugin.js'
import { closedApplicationOps } from '../../../plugin_slot.js'
import { HookBatch } from '../../lifecycle/batch.js'
import { Router } from './programmatic.js'
import { ScopedPlugins } from './scoped_plugins.js'
import { stateOf } from './state.js'

const context: HTTPSetupContext = {
  container: {} as Container,
  config: {} as never,
  store: {} as never,
  logger: newNoopLogger(),
  hasFeature: () => false,
  app: closedApplicationOps(),
}

class Hooking extends HTTPPlugin {
  constructor(readonly hook: () => void) {
    super()
  }

  register({ app }: HTTPSetupContext): void {
    app.hook('onRequest', this.hook)
  }
}

describe('ScopedPlugins', () => {
  it("records a router plugin's hooks under the router, in its place among the router's plugins", async () => {
    const first = (): void => undefined
    const second = (): void => undefined
    const router = new Router('/r').with(() => new Hooking(first)).with(() => new Hooking(second))
    const plugins = new ScopedPlugins()

    await plugins.resolveRouters([router], context)

    const batches = plugins.extensions.of(stateOf(router)!) as HookBatch[]
    expect(batches.every(entry => entry instanceof HookBatch)).toBe(true)
    expect(batches.map(batch => batch.request.onRequest)).toEqual([[first], [second]])
  })
})
