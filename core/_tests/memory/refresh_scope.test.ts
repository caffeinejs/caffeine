import { describe, it, expect } from 'vitest'
import { DiCaf } from '../../container.js'
import { Scopes } from '../../scope.js'
import { forceGC } from './_gc.js'
import { trackForCollection } from './_assert_collected.js'

describe('Refresh scope memory', function () {
  it('releases refresh-scoped instance after resetInstances()', async function () {
    class RefSvc {}

    const di = new DiCaf({ decorators: false })
    di.bind(RefSvc)
      .toSelf()
      .lifetime(Scopes.REFRESH)
    await di.init()
    const isCollected = trackForCollection(di.get(RefSvc)!)

    await di.resetInstances()
    await forceGC()

    expect(isCollected())
      .toBe(true)
    await di.dispose()
  })

  it('releases refresh-scoped instance after dispose()', async function () {
    class RefSvc {}

    const di = new DiCaf({ decorators: false })
    di.bind(RefSvc)
      .toSelf()
      .lifetime(Scopes.REFRESH)
    await di.init()
    const isCollected = trackForCollection(di.get(RefSvc)!)

    await di.dispose()
    await forceGC()

    expect(isCollected())
      .toBe(true)
  })

  it('releases old instance and retains new one after resetInstance()', async function () {
    class RefSvc {}

    const di = new DiCaf({ decorators: false })
    di.bind(RefSvc)
      .toSelf()
      .lifetime(Scopes.REFRESH)
    await di.init()

    const oldRef = trackForCollection(di.get(RefSvc)!)
    await di.resetInstance(RefSvc)
    const newInstance = di.get(RefSvc)!

    await forceGC()

    expect(oldRef())
      .toBe(true)
    expect(newInstance)
      .toBeInstanceOf(RefSvc)
    await di.dispose()
  })
})
