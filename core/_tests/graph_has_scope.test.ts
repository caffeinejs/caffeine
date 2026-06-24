import { describe, it, expect } from 'vitest'
import { CaffeineIoC } from '../container.js'
import { Scopes } from '../scope.js'

describe('hasScopeWithinGraph', function () {
  it('returns false for unregistered key', async function () {
    const di = new CaffeineIoC({ decorators: false })
    await di.init()
    expect(di.hasScopeInGraph(Symbol('not-registered'), Scopes.SINGLETON)).toBe(false)
  })

  it('returns true when root binding has the scope', async function () {
    const kA = Symbol('ghs-root-scope')
    const di = new CaffeineIoC({ decorators: false })
    di.bind(kA).toValue('a')
      .lifetime(Scopes.SINGLETON)
    await di.init()
    expect(di.hasScopeInGraph(kA, Scopes.SINGLETON)).toBe(true)
  })

  it('returns false when root binding does not have the scope', async function () {
    const kA = Symbol('ghs-root-no-scope')
    const di = new CaffeineIoC({ decorators: false })
    di.bind(kA).toValue('a')
      .lifetime(Scopes.TRANSIENT)
    await di.init()
    expect(di.hasScopeInGraph(kA, Scopes.SINGLETON)).toBe(false)
  })

  it('returns true when a transitive dependency has the scope', async function () {
    const kA = Symbol('ghs-trans-a')
    const kB = Symbol('ghs-trans-b')
    const kC = Symbol('ghs-trans-c')
    const di = new CaffeineIoC({ checks: { scopes: 'off' }, decorators: false })
    di.bind(kC).toValue('c')
      .lifetime(Scopes.SINGLETON)
    di.bind(kB).toFunction((_: unknown) => 'b', [kC])
      .lifetime(Scopes.TRANSIENT)
    di.bind(kA).toFunction((_: unknown) => 'a', [kB])
      .lifetime(Scopes.TRANSIENT)
    await di.init()
    expect(di.hasScopeInGraph(kA, Scopes.SINGLETON)).toBe(true)
  })

  it('returns false when no binding in the graph has the scope', async function () {
    const kA = Symbol('ghs-none-a')
    const kB = Symbol('ghs-none-b')
    const di = new CaffeineIoC({ decorators: false })
    di.bind(kB).toValue('b')
      .lifetime(Scopes.TRANSIENT)
    di.bind(kA).toFunction((_: unknown) => 'a', [kB])
      .lifetime(Scopes.TRANSIENT)
    await di.init()
    expect(di.hasScopeInGraph(kA, Scopes.SINGLETON)).toBe(false)
  })

  it('handles cycles without infinite loop', async function () {
    const kA = Symbol('ghs-cycle-a')
    const kB = Symbol('ghs-cycle-b')
    const di = new CaffeineIoC({ checks: { circularReferences: false, scopes: 'off' }, decorators: false })
    di.bind(kA).toFunction((_: unknown) => 'a', [kB])
      .lifetime(Scopes.TRANSIENT)
    di.bind(kB).toFunction((_: unknown) => 'b', [kA])
      .lifetime(Scopes.TRANSIENT)
    await di.init()
    expect(di.hasScopeInGraph(kA, Scopes.SINGLETON)).toBe(false)
  })

  it('finds scope through a named-key injection', async function () {
    const kSvc = 'ghs-named-svc'
    const kOwner = Symbol('ghs-named-owner')
    const di = new CaffeineIoC({ checks: { scopes: 'off' }, decorators: false })
    di.bind(kSvc).toValue('svc')
      .lifetime(Scopes.SINGLETON)
    di.bind(kOwner).toFunction((_: unknown) => 'owner', [kSvc])
      .lifetime(Scopes.TRANSIENT)
    await di.init()
    expect(di.hasScopeInGraph(kOwner, Scopes.SINGLETON)).toBe(true)
  })
})
