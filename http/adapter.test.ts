import { describe, expect, it } from 'vitest'

import { AdapterExtensions, type HTTPSetupContext } from './adapter.js'
import { HookBatch } from './core/lifecycle/batch.js'

describe('AdapterExtensions', () => {
  // A plugin's hooks run where its `.with(...)` stands among the plugins: the list keeps both in one order.
  it('keeps hook batches and extensions in the order added, at the root and per scope', () => {
    const batch = new HookBatch({} as HTTPSetupContext)
    const scope = {}
    const root = new AdapterExtensions<string>().withRoot(['before', batch, 'after'])
    root.add('scoped', scope)
    root.add(batch, scope)

    expect(root.root()).toEqual(['before', batch, 'after'])
    expect(root.of(scope)).toEqual(['scoped', batch])
  })
})
