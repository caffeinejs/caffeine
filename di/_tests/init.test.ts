import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ErrInvalidContainerState } from '../errors.js'
import { Scopes } from '../scope.js'

describe('init() ready state', function () {
  it('should not mark container as ready until all eager singletons are constructed', async function () {
    let readyDuringConstruction = false

    const di = new CaffeineIoC({ decorators: false })

    class EagerBean {
      constructor() {
        readyDuringConstruction = di.ready
      }
    }

    di.bind(EagerBean, t => t.toSelf().lifetime(Scopes.SINGLETON).lazy(false))
    await di.init()

    expect(readyDuringConstruction).toBe(false)
    expect(di.ready).toBe(true)
  })

  it('should keep container not ready when eager singleton construction throws', async function () {
    const di = new CaffeineIoC({ decorators: false })

    class BrokenBean {
      constructor() {
        throw new Error('init failed')
      }
    }

    di.bind(BrokenBean, t => t.toSelf().lifetime(Scopes.SINGLETON).lazy(false))

    await expect(di.init()).rejects.toThrow('init failed')
    expect(di.ready).toBe(false)
  })
})

describe('Binding registration after init()', function () {
  class Svc {}

  it('should throw when calling bind() after init()', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Svc, t => t.toSelf())
    await di.init()

    expect(() => di.bind(Svc, t => t.toSelf())).toThrow(ErrInvalidContainerState)
  })

  it('should throw when calling rebind() after init()', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Svc, t => t.toSelf())
    await di.init()

    expect(() => di.rebind(Svc, t => t.toSelf())).toThrow(ErrInvalidContainerState)
  })

  it('should throw when calling autoWire() after init()', async function () {
    const di = new CaffeineIoC({ decorators: false })
    await di.init()

    expect(() => di.autoWire()).toThrow(ErrInvalidContainerState)
  })
})
