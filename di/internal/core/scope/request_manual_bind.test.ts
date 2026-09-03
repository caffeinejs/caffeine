import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CaffeineIoC } from '../../../container.js'
import { bindScope, Scopes, unbindScope } from '../../../scope.js'
import { RequestScope } from './index.js'

describe('REQUEST scope — manual bindScope', function () {
  beforeEach(function () {
    bindScope(Scopes.REQUEST, () => new RequestScope(new AsyncLocalStorage()))
  })

  afterEach(function () {
    unbindScope(Scopes.REQUEST)
  })

  it('resolves request-scoped beans inside run()', async function () {
    class Svc {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Svc, t => t
      .toSelf()
      .lifetime(Scopes.REQUEST))
    await di.init()

    let resolved: Svc | undefined

    await di.requestScopeManager.run(async () => {
      resolved = di.get(Svc)
    })

    expect(resolved)
      .toBeInstanceOf(Svc)
    await di.dispose()
  })

  it('throws when resolving outside run()', async function () {
    class Svc {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Svc, t => t
      .toSelf()
      .lifetime(Scopes.REQUEST))
    await di.init()

    expect(() => di.get(Svc))
      .toThrow()
    await di.dispose()
  })
})
