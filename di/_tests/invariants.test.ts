import '../index.nodejs.js'
import { describe, expect, it } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ErrCircularDependency, ErrScopeMismatch } from '../errors.js'
import { $i } from '../injection.js'
import type { Provider } from '../provider.js'
import { Scopes } from '../scope.js'

describe('cycle detection beyond required constructor edges', function () {
  it('should throw ErrCircularDependency for a mutual property-injection cycle', async function () {
    class PropA {
      b!: PropB
    }

    class PropB {
      a!: PropA
    }

    const di = new CaffeineIoC({ checks: { circularReferences: true }, decorators: false })
    di.bind(PropA, t => t.toSelf().injectProperty('b', PropB))
    di.bind(PropB, t => t.toSelf().injectProperty('a', PropA))

    await expect(di.init()).rejects.toThrow(ErrCircularDependency)
  })

  it('should throw ErrCircularDependency for a mutual method-injection cycle', async function () {
    class MethodA {
      b!: MethodB

      setB(b: MethodB) {
        this.b = b
      }
    }

    class MethodB {
      a!: MethodA

      setA(a: MethodA) {
        this.a = a
      }
    }

    const di = new CaffeineIoC({ checks: { circularReferences: true }, decorators: false })
    di.bind(MethodA, t => t.toSelf().injectMethod('setB', MethodB))
    di.bind(MethodB, t => t.toSelf().injectMethod('setA', MethodA))

    await expect(di.init()).rejects.toThrow(ErrCircularDependency)
  })

  it('should throw ErrCircularDependency for an allOf cycle without defer', async function () {
    abstract class Handler {}

    class HandlerA extends Handler {
      constructor(readonly peers: Handler[]) {
        super()
      }
    }

    class HandlerB extends Handler {
      constructor(readonly a: HandlerA) {
        super()
      }
    }

    const di = new CaffeineIoC({ checks: { circularReferences: true }, decorators: false })
    di.bind(HandlerA, t => t.toSelf([$i.allOf(Handler)]).extends(Handler))
    di.bind(HandlerB, t => t.toSelf([HandlerA]).extends(Handler))

    await expect(di.init()).rejects.toThrow(ErrCircularDependency)
  })

  it('should throw ErrCircularDependency for an eager optional constructor cycle', async function () {
    class OptA {
      constructor(readonly b?: OptB) {}
    }

    class OptB {
      constructor(readonly a: OptA) {}
    }

    const di = new CaffeineIoC({ checks: { circularReferences: true }, decorators: false })
    di.bind(OptA, t => t.toSelf([$i.optional(OptB)]))
    di.bind(OptB, t => t.toSelf([OptA]))

    await expect(di.init()).rejects.toThrow(ErrCircularDependency)
  })
})

describe('partial checks must not drop circularReferences default', function () {
  it('should throw ErrCircularDependency when only checks.scopes is set to off', async function () {
    class CycleA {
      constructor(readonly b: CycleB) {}
    }

    class CycleB {
      constructor(readonly a: CycleA) {}
    }

    const di = new CaffeineIoC({ checks: { scopes: 'off' }, decorators: false })
    di.bind(CycleA, t => t.toSelf([CycleB]))
    di.bind(CycleB, t => t.toSelf([CycleA]))

    await expect(di.init()).rejects.toThrow(ErrCircularDependency)
  })
})

describe('singleton must not retain a destroyed refresh collaborator', function () {
  class Token {
    die() {
      //
    }
  }

  class App {
    constructor(readonly token: Token) {}
  }

  it('should reject a singleton that captures a refresh instance directly', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Token, t =>
      t
        .toSelf()
        .lifetime(Scopes.REFRESH)
        .preDestroy(token => token.die()),
    )
    di.bind(App, t => t.toSelf([Token]))

    await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
  })

  it('should let a singleton reach a refresh instance through a provider and see it after refresh()', async function () {
    const destroyed: Token[] = []

    class Holder {
      constructor(readonly token: Provider<Token>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Token, t =>
      t
        .toSelf()
        .lifetime(Scopes.REFRESH)
        .preDestroy(token => {
          destroyed.push(token)
        }),
    )
    di.bind(Holder, t => t.toSelf([$i.provide(Token)]))
    await di.init()

    const holder = di.get(Holder)
    const before = holder.token.get()

    await di.refresher.refresh()

    expect(destroyed).toEqual([before])
    expect(holder.token.get()).not.toBe(before)
    expect(holder.token.get()).toBe(di.get(Token))
  })
})

describe('preDestroy on request-scoped beans', function () {
  it('should call preDestroy once when dispose() runs inside an active run() block', async function () {
    let calls = 0

    class RequestSvc {
      die() {
        calls++
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(RequestSvc, t =>
      t
        .toSelf()
        .lifetime(Scopes.REQUEST)
        .preDestroy(svc => svc.die()),
    )
    await di.init()

    await di.requestScopeManager.run(async function () {
      di.get(RequestSvc)
      await di.dispose()
    })

    expect(calls).toBe(1)
  })
})
