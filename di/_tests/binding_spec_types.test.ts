import { describe, expect, it } from 'vitest'

import { $i, CaffeineIoC, ErrInvalidBinding, token } from '../index.js'

class Repo {
  find(): string {
    return 'row'
  }
}

class Logger {
  log(message: string): void {
    void message
  }
}

class Service {
  constructor(
    readonly repo: Repo,
    readonly logger: Logger,
  ) {}
}

class OptionalDep {
  constructor(
    readonly repo: Repo,
    readonly logger: Logger | undefined,
  ) {}
}

class SelfDep {
  constructor(readonly self: SelfDep) {}
}

class SelfDepImpl extends SelfDep {}

class CycleB {
  constructor(readonly a: CycleA) {}

  b(): void {}
}

class CycleA {
  constructor(readonly b: CycleB) {}

  a(): void {}
}

/** A dependency type with no members: structurally, every value satisfies it. */
class NoMembers {}

class Structural {
  constructor(readonly dep: NoMembers) {}
}

/**
 * Compile-time contract of the injection lists. Never called: the assertions are the
 * `@ts-expect-error` comments, which fail the build if the error they mark stops happening.
 */
function injectionTupleTypeChecks(di: CaffeineIoC): void {
  di.bind(Service, t => t.toClass(Service, [Repo, Logger]))
  di.bind(Service, t => t.toSelf([Repo, Logger]))

  di.bind(Service, t =>
    t.toClass(Service, [
      // @ts-expect-error dependencies are checked by position, not as a set
      Logger,
      // @ts-expect-error same swap, seen from the second parameter
      Repo,
    ]),
  )

  // @ts-expect-error one injection for a two-parameter constructor
  di.bind(Service, t => t.toClass(Service, [Repo]))

  di.bind(Service, t =>
    t.toClass(Service, [
      Repo,
      Logger,
      // @ts-expect-error more injections than constructor parameters
      Repo,
    ]),
  )

  di.bind(OptionalDep, t => t.toSelf([Repo, $i.optional(Logger)]))

  // `InjectionDescriptor`'s result brand is optional, so `T | undefined` satisfies a `T` parameter: an
  // `$i.optional` dependency on a required parameter is accepted. Widening the parameter is the caller's call.
  di.bind(Service, t => t.toSelf([Repo, $i.optional(Logger)]))

  di.bind(Service, t =>
    t.toSelf([
      Repo,
      // @ts-expect-error a collection injection does not satisfy a single-instance parameter
      $i.allOf(Logger),
    ]),
  )

  // `$i.defer` is how a genuine cycle is expressed, so it stays legal.
  di.bind(SelfDep, t => t.toSelf([$i.defer(() => SelfDep)]))

  // Two classes that reference each other are a cycle, not a self injection.
  di.bind(CycleA, t => t.toSelf([CycleB]))
  di.bind(CycleB, t => t.toSelf([CycleA]))

  // A dependency whose type has no members is satisfied by anything — TypeScript is structural, so this is
  // accepted on both paths and there is no typing that rejects it. Self injection is caught at run time.
  di.bind(Structural, t => t.toSelf([Logger]))
  di.bind(Structural, t => t.toClass(Structural, [Logger]))

  const kName = token<string>('name')

  // @ts-expect-error toSelf() requires a constructable key
  di.bind(kName, t => t.toSelf())

  // @ts-expect-error the bound value must match the token
  di.bind(kName, t => t.toValue(42))

  di.bind(kName, t => t.toFunction(repo => repo.find(), [Repo]))

  // @ts-expect-error the function returns a type the token does not accept
  di.bind(kName, t => t.toFunction(() => 42))

  di.bind(kName, t =>
    t.toFunction(
      // @ts-expect-error the parameter is typed from the injection list, and Repo has no such member
      repo => repo.missingMember(),
      [Repo],
    ),
  )
}

void injectionTupleTypeChecks

describe('BindingSpec injection lists', function () {
  it('should still reject a mismatched injection count at run time, for callers without types', function () {
    const di = new CaffeineIoC({ decorators: false })

    expect(() => di.bind(Service, t => t.toClass(Service, [Repo] as never))).toThrow(ErrInvalidBinding)
  })

  it('should reject a component listed among its own dependencies', function () {
    const di = new CaffeineIoC({ decorators: false })

    expect(() => di.bind(SelfDep, t => t.toSelf([SelfDep]))).toThrow(ErrInvalidBinding)
    expect(() => di.bind(SelfDep, t => t.toClass(SelfDep, [SelfDep]))).toThrow(ErrInvalidBinding)
  })

  it('should reject a component listed under the key it is bound to', function () {
    const di = new CaffeineIoC({ decorators: false })

    // The key and the implementation differ, but injecting the key is the same cycle.
    expect(() => di.bind(SelfDep, t => t.toClass(SelfDepImpl, [SelfDep]))).toThrow(ErrInvalidBinding)
  })

  it('should accept a deferred self reference, which is how a cycle is expressed', async function () {
    const di = new CaffeineIoC({ decorators: false })

    di.bind(SelfDep, t => t.toSelf([$i.defer(() => SelfDep)]))
    await di.init()

    expect(di.get(SelfDep)).toBeInstanceOf(SelfDep)
  })

  it('should resolve a constructor whose dependencies are given in order', async function () {
    const di = new CaffeineIoC({ decorators: false })

    di.bind(Repo, t => t.toSelf())
      .bind(Logger, t => t.toSelf())
      .bind(Service, t => t.toSelf([Repo, Logger]))

    await di.init()

    expect(di.get(Service).repo).toBeInstanceOf(Repo)
    expect(di.get(Service).logger).toBeInstanceOf(Logger)
  })
})
