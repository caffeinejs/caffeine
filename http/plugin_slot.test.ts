import { describe, expect, it } from 'vitest'

import type { HTTPSetupContext } from './adapter.js'
import { ErrConfiguration } from './core/error/common.js'
import { HTTPPlugin } from './plugin.js'
import { kEngineOnly } from './plugin_marks.js'
import { PluginSlot } from './plugin_slot.js'

class Named extends HTTPPlugin {
  constructor(override readonly name: string) {
    super()
  }

  register(): void {}
}

const kit = {} as HTTPSetupContext

describe('PluginSlot', () => {
  // A hook added after the slot closed would never be installed: refused so the plugin finds out.
  it('refuses a hook outside the slot', () => {
    expect(() => new PluginSlot().hook('onRequest', () => undefined)).toThrow(ErrConfiguration)
  })

  it('adds a hook to the batch of the entry that is running', async () => {
    const slot = new PluginSlot()
    const hook = (): void => undefined

    const { batch } = await slot.during(() => slot.run(() => void slot.hook('preHandler', hook), kit, 'here'))

    expect(batch.request.preHandler).toEqual([hook])
  })

  // A caller the types did not stop, plain JavaScript or a cast, finds out at start-up rather than never.
  it('refuses a point that is not a hook', async () => {
    const slot = new PluginSlot()

    await expect(
      slot.during(() => slot.run(() => void slot.hook('onTimeout' as 'onRequest', () => undefined), kit, 'here')),
    ).rejects.toThrow(ErrConfiguration)
  })

  it('answers hasPlugin for a plugin claimed earlier, itself included, and not for a later one', async () => {
    const slot = new PluginSlot()
    const seen: boolean[] = []

    await slot.during(async () => {
      slot.claim(new Named('first'), 'on the test server')
      seen.push(slot.hasPlugin('first'), slot.hasPlugin('second'))
      slot.claim(new Named('second'), 'on the test server')
    })

    expect(seen).toEqual([true, false])
  })

  it('refuses a name claimed twice in one slot', () => {
    const slot = new PluginSlot()
    slot.claim(new Named('cors'), 'on the test server')

    expect(() => slot.claim(new Named('cors'), 'on the test server')).toThrow(
      'Cannot register plugin "cors" twice on the test server',
    )
  })

  it('refuses an empty name', () => {
    expect(() => new PluginSlot().claim(new Named(''), 'on the test server')).toThrow(
      'Cannot register a plugin with an empty name on the test server',
    )
  })

  it("marks the batch of an engine-only plugin with the name Fastify's entry exports instead", async () => {
    class EngineOnly extends HTTPPlugin {
      readonly [kEngineOnly] = 'x'

      register(): void {}
    }

    const slot = new PluginSlot()
    const marked = await slot.during(() => slot.run(() => new EngineOnly(), kit, 'here'))
    const plain = await slot.during(() => slot.run(() => new Named('plain'), kit, 'here'))

    expect(marked.batch.engineOnly).toBe('x')
    expect(plain.batch.engineOnly).toBe(undefined)
  })
})
