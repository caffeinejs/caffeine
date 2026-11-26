import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from './core/error/common.js'
import { HookRegistration, type HookBatch } from './core/lifecycle/batch.js'
import { findMyWayMatcher } from './core/matcher/find_my_way.js'
import { HTTPPlugin, type HTTPSetupContext } from './plugin.js'
import { PluginSlot } from './plugin_slot.js'

class Named extends HTTPPlugin {
  constructor(override readonly name: string) {
    super()
  }

  register(): void {}
}

const kit = {} as HTTPSetupContext
const noop = (): void => undefined

describe('PluginSlot', () => {
  // A hook added after the slot closed would never be installed: refused so the plugin finds out.
  it('refuses a hook outside the slot', () => {
    expect(() => new PluginSlot().hook('onRequest', () => undefined)).toThrow(ErrConfiguration)
  })

  it('adds a hook to the batch of the entry that is running', async () => {
    const slot = new PluginSlot()
    const hook = (): void => undefined

    const batches: HookBatch[] = []
    await slot.during(() =>
      slot.run(
        () => new HookRegistration('preHandler', hook),
        { ...kit, server: slot },
        'here',
        batch => batches.push(batch),
      ),
    )

    expect(batches.map(batch => batch.request.preHandler)).toEqual([[hook]])
  })

  // The engine installs plugins alone: anything else a factory hands back is refused while its slot runs, naming it.
  it('refuses a factory that returns no HTTPPlugin, naming where', async () => {
    const slot = new PluginSlot()

    await expect(slot.during(() => slot.run(() => undefined, kit, 'on listener "admin"', noop))).rejects.toThrow(
      'Cannot install a server plugin on listener "admin": only an HTTPPlugin can be installed',
    )
  })

  // A caller the types did not stop, plain JavaScript or a cast, finds out at start-up rather than never.
  it('refuses a point that is not a hook', async () => {
    const slot = new PluginSlot()

    await expect(
      slot.during(() => slot.run(() => void slot.hook('onTimeout' as 'onRequest', () => undefined), kit, 'here', noop)),
    ).rejects.toThrow(ErrConfiguration)
  })

  // Each plugin's server is open for its own registration alone: one kept by an earlier plugin is refused during a later
  // one's, though the slot is still open.
  it("refuses an earlier plugin's server while a later plugin registers", async () => {
    const slot = new PluginSlot()
    let kept: HTTPSetupContext['server'] | undefined
    const context = { ...kit, server: slot }

    const outcome = await slot
      .during(async () => {
        await slot.run(
          ({ server }) =>
            new (class extends HTTPPlugin {
              register(): void {
                kept = server
              }
            })(),
          context,
          'here',
          noop,
        )
        await slot.run(
          () =>
            new (class extends HTTPPlugin {
              register(): void {
                kept!.mount()
              }
            })(),
          context,
          'here',
          noop,
        )
      })
      .catch((err: unknown) => err)

    expect((outcome as Error).message.split('\n')[0]).toBe(
      'Cannot call "server.mount" here: a plugin\'s server operations are open only while it registers',
    )
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

  // Two of one plugin in one slot is the user's to decide: both register.
  it('claims one name twice in one slot', async () => {
    const slot = new PluginSlot()
    const seen: boolean[] = []

    await slot.during(async () => {
      slot.claim(new Named('cors'), 'on the test server')
      slot.claim(new Named('cors'), 'on the test server')
      seen.push(slot.hasPlugin('cors'))
    })

    expect(seen).toEqual([true])
  })

  // The identity is the server's, set before the slot opens; the prefix is the slot's own.
  it("reports its server's identity and its own prefix", () => {
    const slot = new PluginSlot(undefined, '/r')
    slot.forServer({ name: 'admin', basePath: '/api', matcher: findMyWayMatcher, address: () => undefined })

    expect({ name: slot.name, basePath: slot.basePath, prefix: slot.prefix, address: slot.address }).toEqual({
      name: 'admin',
      basePath: '/api',
      prefix: '/r',
      address: undefined,
    })
  })

  it('refuses to report a server before it belongs to one', () => {
    expect(() => new PluginSlot().basePath).toThrow(
      'Cannot read the server of a plugin slot: the slot belongs to no server yet',
    )
  })

  it('refuses an empty name', () => {
    expect(() => new PluginSlot().claim(new Named(''), 'on the test server')).toThrow(
      'Cannot register a plugin with an empty name on the test server',
    )
  })
})
