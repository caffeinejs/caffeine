import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../../container.js'
import { trackForCollection } from './_assert_collected.js'
import { forceGC } from './_gc.js'

describe('HookListener memory', function () {
  it('container is GC-able after dispose when no external references remain', async function () {
    let isCollected!: () => boolean

    const run = async () => {
      const di = new CaffeineIoC({ decorators: false })
      isCollected = trackForCollection(di)
      await di.init()
      await di.dispose()
    }

    await run()
    await forceGC()

    expect(isCollected()).toBe(true)
  })

  it('container is GC-able when a hook listener was registered', async function () {
    let isCollected!: () => boolean

    const run = async () => {
      const di = new CaffeineIoC({ decorators: false })
      const listener = () => {}
      di.hooks.on('onDisposed', listener)
      isCollected = trackForCollection(di)
      await di.init()
      await di.dispose()
    }

    await run()
    await forceGC()

    expect(isCollected()).toBe(true)
  })

  it('once() listener is removed after firing', async function () {
    const di = new CaffeineIoC({ decorators: false })
    let fired = 0
    const listener = () => fired++

    di.hooks.once('onDisposed', listener)
    await di.init()
    await di.dispose()

    expect(fired).toBe(1)
    const listenerMapSize = (di.hooks as any)._listeners.get('onDisposed')?.size ?? 0
    expect(listenerMapSize).toBe(0)
  })

  it('container registered as hook target does not form a retain cycle preventing GC', async function () {
    let isCollected!: () => boolean

    const run = async () => {
      const di = new CaffeineIoC({ decorators: false })
      di.hooks.on('onDisposed', () => {
        void di.size
      })
      isCollected = trackForCollection(di)
      await di.init()
      await di.dispose()
    }

    await run()
    await forceGC()

    expect(isCollected()).toBe(true)
  })
})
