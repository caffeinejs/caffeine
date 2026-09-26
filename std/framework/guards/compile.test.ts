import { CaffeineIoC, Scopes, token, type InjectionToken } from '@caffeinejs/di'
import { describe, it, expect } from 'vitest'

import { compileGuardKeys, type CompiledGuard } from './compile.js'
import { ErrGuardConfiguration } from './errors.js'
import type { BaseGuard } from './guard.js'

type TestGuard = BaseGuard<unknown>

// `decorators: false` keeps the global `@Injectable` registry out of these containers, so nothing another test
// file declares reaches them, and nothing declared here reaches another.
function newContainer(): CaffeineIoC {
  return new CaffeineIoC({ decorators: false })
}

function compile(container: CaffeineIoC, keys: readonly InjectionToken<TestGuard>[]): CompiledGuard<TestGuard>[] {
  return compileGuardKeys(container, keys, 'PetController.list', new Map())
}

class AllowGuard implements TestGuard {
  guard(): boolean {
    return true
  }
}

describe('compile_guard_keys', () => {
  it('refuses a request-scoped class with no "guard" method', async () => {
    // Nothing is resolved outside a request on this path, so the prototype is the only thing to check
    // against — and checking it at start-up is what stops the failure landing on every request instead.
    class NotAGuard {
      ping(): boolean {
        return true
      }
    }

    const container = newContainer()
    container.bind(NotAGuard, t => t.toSelf().lifetime(Scopes.REQUEST))
    await container.init()

    expect(() => compile(container, [NotAGuard as never])).toThrow(ErrGuardConfiguration)
    expect(() => compile(container, [NotAGuard as never])).toThrow(/no "guard" method/)
  })

  it('refuses a singleton with no "guard" method, checking the instance it built', async () => {
    const kNotAGuard = token<TestGuard>(Symbol('not-a-guard'))

    const container = newContainer()
    container.bind(kNotAGuard, t => t.toValue({ ping: () => true } as never))
    await container.init()

    expect(() => compile(container, [kNotAGuard])).toThrow(ErrGuardConfiguration)
  })

  it('accepts a request-scoped factory binding, which has no prototype to inspect', async () => {
    const kGuard = token<TestGuard>(Symbol('factory-guard'))

    const container = newContainer()
    container.bind(kGuard, t => t.toFactory(() => new AllowGuard()).lifetime(Scopes.REQUEST))
    await container.init()

    // Taken on trust: a factory says nothing about the shape it will return, and the alternative is
    // refusing a legitimate guard at start-up.
    expect(compile(container, [kGuard])).toEqual([{ kind: 'provider', provider: expect.anything() }])
  })

  it('names a guard bound under a named token, and what referenced it, when it cannot be resolved', async () => {
    const kMissing = token<TestGuard>(Symbol('audit-guard'))

    const container = newContainer()
    await container.init()

    expect(() => compile(container, [kMissing])).toThrow(ErrGuardConfiguration)
    expect(() => compile(container, [kMissing])).toThrow(/Symbol\(audit-guard\).*PetController\.list/s)
  })

  it('compiles a singleton guard to the instance it built', async () => {
    const container = newContainer()
    container.bind(AllowGuard, t => t.toSelf().lifetime(Scopes.SINGLETON))
    await container.init()

    expect(compile(container, [AllowGuard])).toEqual([{ kind: 'instance', instance: expect.any(AllowGuard) }])
  })

  it('yields an empty chain for an empty key list', async () => {
    const container = newContainer()
    await container.init()

    expect(compile(container, [])).toEqual([])
  })

  it('hands back the same compiled entry for a token it already compiled', async () => {
    // Identity is what a transport's chain dedupes on, so one token must never compile to two entries.
    const container = newContainer()
    container.bind(AllowGuard, t => t.toSelf().lifetime(Scopes.SINGLETON))
    await container.init()

    const cache = new Map<InjectionToken<TestGuard>, CompiledGuard<TestGuard>>()
    const [first] = compileGuardKeys<TestGuard>(container, [AllowGuard], 'first', cache)
    const [second] = compileGuardKeys<TestGuard>(container, [AllowGuard], 'second', cache)

    expect(second).toBe(first)
  })
})
