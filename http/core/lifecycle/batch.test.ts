import { describe, expect, it } from 'vitest'

import type { HTTPSetupContext } from '../../plugin.js'
import { HookBatch } from './batch.js'

const kit = {} as HTTPSetupContext

describe('HookBatch', () => {
  it('keeps the hooks of one point in the order they were added', () => {
    const batch = new HookBatch(kit)
    const first = (): void => undefined
    const second = (): void => undefined

    batch.add('preHandler', first)
    batch.add('preHandler', second)
    batch.add('onReady', first)

    expect(batch.request.preHandler).toEqual([first, second])
    expect(batch.onReady).toEqual([first])
  })
})
