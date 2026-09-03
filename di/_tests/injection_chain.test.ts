import { describe, expect, it } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { DeferredCtor } from '../deferred_ctor.js'
import { ErrConflictingInjectionStages } from '../errors.js'
import type { InjectionDescriptor } from '../injection.js'
import { BuiltInStages } from '../injection_resolver.js'
import { token } from '../key.js'
import type { Provider } from '../provider.js'
import { Scopes } from '../scope.js'

// Drives compileChain through raw stage descriptors, which is the only way to reach it until the `$i` helpers
// emit stages. What it pins down is the compiler's own contract: the terminal runs last whatever order the
// stages were declared in, seeding unwraps a deferred key, and two terminals are refused.

interface Plugin {
  id(): string
}

const kPlug = token<Plugin>(Symbol('chain-plugin'))

class Alpha implements Plugin {
  id(): string {
    return 'alpha'
  }
}

class Beta implements Plugin {
  id(): string {
    return 'beta'
  }
}

class Gamma implements Plugin {
  id(): string {
    return 'gamma'
  }
}

async function container(): Promise<CaffeineIoC> {
  const di = new CaffeineIoC({ decorators: false })
  di.bind(Alpha, t => t.toSelf().names(kPlug).order(2))
  di.bind(Beta, t => t.toSelf().names(kPlug).order(1))
  di.bind(Gamma, t => t.toSelf().names(kPlug).order(3))
  await di.init()

  return di
}

const chain = (descriptor: InjectionDescriptor): InjectionDescriptor => descriptor

describe('compileChain', function () {
  it('resolves the single binding when no stage is named', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Alpha, t => t.toSelf())
    await di.init()

    const resolve = di.resolver(chain({ key: Alpha, stages: [] }) as never)

    expect(resolve()).toBeInstanceOf(Alpha)
  })

  it('collects every binding with the array terminal', async function () {
    const di = await container()
    const resolve = di.resolver(chain({ key: kPlug, stages: [{ name: BuiltInStages.MANY }] }) as never)

    expect(resolve()).toHaveLength(3)
  })

  it('sorts before collecting when the sort stage precedes the terminal', async function () {
    const di = await container()
    const resolve = di.resolver(
      chain({ key: kPlug, stages: [{ name: BuiltInStages.SORT }, { name: BuiltInStages.MANY }] }) as never,
    )

    expect((resolve() as Plugin[]).map(p => p.id())).toEqual(['beta', 'alpha', 'gamma'])
  })

  it('runs the terminal last however the stages were ordered', async function () {
    const di = await container()

    // The provider stage is declared after the terminal here and before it in the next case. Both mean the same
    // chain, because one wraps the resolver on the way back up and the other only decides what is resolved.
    const after = di.resolver(
      chain({
        key: kPlug,
        stages: [{ name: BuiltInStages.SORT }, { name: BuiltInStages.MANY }, { name: BuiltInStages.PROVIDER }],
      }) as never,
    )
    const before = di.resolver(
      chain({
        key: kPlug,
        stages: [{ name: BuiltInStages.PROVIDER }, { name: BuiltInStages.SORT }, { name: BuiltInStages.MANY }],
      }) as never,
    )

    const fromAfter = (after() as Provider<Plugin[]>).get()
    const fromBefore = (before() as Provider<Plugin[]>).get()

    expect(fromAfter.map(p => p.id())).toEqual(['beta', 'alpha', 'gamma'])
    expect(fromBefore.map(p => p.id())).toEqual(fromAfter.map(p => p.id()))
  })

  it('re-resolves through the provider stage on every get', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Alpha, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    await di.init()

    const provider = di.resolver(
      chain({ key: Alpha, stages: [{ name: BuiltInStages.PROVIDER }] }) as never,
    )() as Provider<Alpha>

    expect(provider.get()).not.toBe(provider.get())
  })

  it('throws ErrConflictingInjectionStages when two stages both decide the result', async function () {
    const di = await container()

    expect(() =>
      di.resolver(chain({ key: kPlug, stages: [{ name: BuiltInStages.MANY }, { name: BuiltInStages.MAP }] }) as never),
    ).toThrow(ErrConflictingInjectionStages)
  })

  it('unwraps a deferred key when seeding, so collecting stages see the bindings', async function () {
    const di = await container()
    const resolve = di.resolver(
      chain({
        key: new DeferredCtor(() => kPlug),
        stages: [{ name: BuiltInStages.SORT }, { name: BuiltInStages.MANY }],
      }) as never,
    )

    expect((resolve() as Plugin[]).map(p => p.id())).toEqual(['beta', 'alpha', 'gamma'])
  })

  it('resolves a deferred key through a proxy when no stage is named', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Alpha, t => t.toSelf())
    await di.init()

    const resolve = di.resolver(chain({ key: new DeferredCtor(() => Alpha), stages: [] }) as never)

    expect((resolve() as Alpha).id()).toEqual('alpha')
  })

  it('resolves a constant from the value terminal', async function () {
    const di = await container()
    const resolve = di.resolver(chain({ stages: [{ name: BuiltInStages.VALUE, args: 'hello' }] }) as never)

    expect(resolve()).toEqual('hello')
  })

  it('resolves undefined for an optional key with no binding', async function () {
    const di = await container()
    const resolve = di.resolver(
      chain({ key: token<Plugin>(Symbol('chain-absent')), optional: true, stages: [] }) as never,
    )

    expect(resolve()).toBeUndefined()
  })
})
