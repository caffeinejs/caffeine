import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../../container.js'
import { Scopes } from '../../scope.js'
import { trackForCollection } from './_assert_collected.js'
import { forceGC } from './_gc.js'

describe('Transient scope memory', function () {
  it('does not retain transient instances after resolution', async function () {
    class TrSvc {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(TrSvc, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    await di.init()

    const refs = Array.from({ length: 10 }, () => trackForCollection(di.get(TrSvc)!))

    await forceGC()

    expect(refs.every(r => r())).toBe(true)
    await di.dispose()
  })

  it('each resolution produces an independent unreferenced instance', async function () {
    class TrSvc {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(TrSvc, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    await di.init()

    const isCollected = trackForCollection(di.get(TrSvc)!)

    await forceGC()

    expect(isCollected()).toBe(true)
    await di.dispose()
  })
})
