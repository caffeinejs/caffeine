import '../../index.nodejs.js'
import { describe, it, expect } from 'vitest'
import { DiCaf } from '../../container.js'
import { Scopes } from '../../scope.js'
import { forceGC } from './_gc.js'
import { trackForCollection } from './_assert_collected.js'

describe('Request scope memory', function () {
  it('releases request-scoped instance after run() resolves', async function () {
    class ReqSvc {}

    const di = new DiCaf({ decorators: false })
    di.bind(ReqSvc)
      .toSelf()
      .lifetime(Scopes.REQUEST)

    await di.init()

    let isCollected!: () => boolean

    await di.requestScopeManager.run(async () => {
      const inst = di.get(ReqSvc)!
      isCollected = trackForCollection(inst)
    })

    await forceGC()

    expect(isCollected())
      .toBe(true)
    await di.dispose()
  })

  it('multiple request runs do not accumulate instances', async function () {
    class ReqSvc {}

    const di = new DiCaf({ decorators: false })
    di.bind(ReqSvc)
      .toSelf()
      .lifetime(Scopes.REQUEST)

    await di.init()

    const refs: Array<() => boolean> = []

    for (let i = 0; i < 10; i++) {
      await di.requestScopeManager.run(async () => {
        refs.push(trackForCollection(di.get(ReqSvc)!))
      })
    }

    await forceGC()

    expect(refs.every(r => r()))
      .toBe(true)
    await di.dispose()
  })

  it('RequestScopeContext destroys instances on run() completion', async function () {
    class ReqSvc {}

    const di = new DiCaf({ decorators: false })
    di.bind(ReqSvc)
      .toSelf()
      .lifetime(Scopes.REQUEST)

    await di.init()

    let capturedRef!: () => boolean

    await di.requestScopeManager.run(async () => {
      capturedRef = trackForCollection(di.get(ReqSvc)!)
    })

    await forceGC()

    expect(capturedRef())
      .toBe(true)
    await di.dispose()
  })
})
