import '../index.nodejs.js'
import { describe, expect, it } from 'vitest'
import { CaffeineIoC } from '../container.js'
import { ErrCircularDependency } from '../errors.js'
import { $i } from '../injection.js'
import { Scopes } from '../scope.js'

describe.skip('cycle detection beyond required constructor edges', function () {
  it('should throw ErrCircularDependency for a mutual property-injection cycle', async function () {
    class PropA {
      b!: PropB
    }

    class PropB {
      a!: PropA
    }

    const di = new CaffeineIoC({ checks: { circularReferences: true }, decorators: false })
    di.bind(PropA, t => t
      .toSelf()
      .injectProperty('b', PropB))
    di.bind(PropB, t => t
      .toSelf()
      .injectProperty('a', PropA))

    await expect(di.init())
      .rejects
      .toThrow(ErrCircularDependency)
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
    di.bind(MethodA, t => t
      .toSelf()
      .injectMethod('setB', MethodB))
    di.bind(MethodB, t => t
      .toSelf()
      .injectMethod('setA', MethodA))

    await expect(di.init())
      .rejects
      .toThrow(ErrCircularDependency)
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
    di.bind(HandlerA, t => t
      .toSelf([$i.allOf(Handler)])
      .extends(Handler))
    di.bind(HandlerB, t => t
      .toSelf([HandlerA])
      .extends(Handler))

    await expect(di.init())
      .rejects
      .toThrow(ErrCircularDependency)
  })

  it('should throw ErrCircularDependency for an eager optional constructor cycle', async function () {
    class OptA {
      constructor(readonly b?: OptB) {}
    }

    class OptB {
      constructor(readonly a: OptA) {}
    }

    const di = new CaffeineIoC({ checks: { circularReferences: true }, decorators: false })
    di.bind(OptA, t => t
      .toSelf([$i.optional(OptB)]))
    di.bind(OptB, t => t
      .toSelf([OptA]))

    await expect(di.init())
      .rejects
      .toThrow(ErrCircularDependency)
  })
})

describe.skip('partial checks must not drop circularReferences default', function () {
  it('should throw ErrCircularDependency when only checks.scopes is set to off', async function () {
    class CycleA {
      constructor(readonly b: CycleB) {}
    }

    class CycleB {
      constructor(readonly a: CycleA) {}
    }

    const di = new CaffeineIoC({ checks: { scopes: 'off' }, decorators: false })
    di.bind(CycleA, t => t
      .toSelf([CycleB]))
    di.bind(CycleB, t => t
      .toSelf([CycleA]))

    await expect(di.init())
      .rejects
      .toThrow(ErrCircularDependency)
  })
})

describe.skip('singleton must not retain a destroyed refresh collaborator', function () {
  it('should not leave a singleton holding a preDestroyed refresh instance after refresh()', async function () {
    const destroyed: Token[] = []

    class Token {
      die() {
        destroyed.push(this)
      }
    }

    class App {
      constructor(readonly token: Token) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Token, t => t
      .toSelf()
      .lifetime(Scopes.REFRESH)
      .preDestroy(token => token.die()))
    di.bind(App, t => t
      .toSelf([Token]))
    await di.init()

    const app = di.get(App)
    await di.refresher.refresh()

    expect(destroyed)
      .not
      .toContain(app.token)
    expect(app.token)
      .toBe(di.get(Token))
  })
})

describe.skip('builder() request-scoped dependencies', function () {
  it('should not reuse a request-scoped dep captured in a previous run() block', async function () {
    class Sess {
      readonly id = Math.random()
    }

    class Use {
      constructor(readonly sess: Sess) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Sess, t => t
      .toSelf()
      .lifetime(Scopes.REQUEST))
    await di.init()

    let builder!: () => Use
    let firstId!: number

    await di.requestScopeManager.run(function () {
      builder = di.builder(Use, [Sess])
      firstId = builder().sess.id
    })

    await di.requestScopeManager.run(function () {
      expect(builder().sess.id)
        .not
        .toBe(firstId)
    })
  })
})

describe.skip('preDestroy on request-scoped beans', function () {
  it('should call preDestroy once when dispose() runs inside an active run() block', async function () {
    let calls = 0

    class RequestSvc {
      die() {
        calls++
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(RequestSvc, t => t
      .toSelf()
      .lifetime(Scopes.REQUEST)
      .preDestroy(svc => svc.die()))
    await di.init()

    await di.requestScopeManager.run(async function () {
      di.get(RequestSvc)
      await di.dispose()
    })

    expect(calls)
      .toBe(1)
  })
})
