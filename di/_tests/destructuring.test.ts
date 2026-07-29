import { describe, it, expect } from 'vitest'
import { Injectable } from '../decorators/injectable.js'
import { Named } from '../decorators/named.js'
import { $i } from '../injection.js'
import { CaffeineIoC } from '../container.js'

describe('Destructuring', function () {
  const kDep = Symbol('test')
  const kBase = Symbol('base-impls')
  const kSymbolField = Symbol('symbol-field')

  abstract class Base {}

  @Injectable()
  @Named(kBase)
  class Impl1 extends Base {}

  @Injectable()
  @Named(kBase)
  class Impl2 extends Base {}

  @Injectable()
  class Dep1 {}

  class Dep2 {}

  @Injectable(kDep)
  class Dep3 {}

  @Injectable([
    $i.object({
      dep1: Dep1,
      dep2: $i.optional(Dep2),
      dep3: kDep,
      base: $i.allOf(kBase),
    }),
  ])
  class Root {
    constructor(readonly args: { dep1: Dep1, dep2?: Dep2, dep3: Dep3, base: Base[] }) {}
  }

  @Injectable([
    $i.object({ dep1: Dep1, dep2: $i.optional(Dep2) }),
    $i.object({ dep3: kDep }),
    $i.optional(Dep2),
    $i.allOf(kBase),
    $i.object({ base: $i.allOf(kBase) }),
  ])
  class DiffTypes {
    constructor(
      readonly args: { dep1: Dep1 },
      readonly other: { dep3: Dep3 },
      readonly dep2: Dep2 | undefined,
      readonly base: Base[],
      readonly another: { base: Base[] },
    ) {}
  }

  @Injectable([
    $i.object({
      services: {
        db: Dep1,
        cache: $i.optional(Dep2),
      },
      config: {
        auth: { token: kDep },
      },
    }),
  ])
  class Nested {
    constructor(readonly args: { services: { db: Dep1, cache?: Dep2 }, config: { auth: { token: Dep3 } } }) {}
  }

  @Injectable([
    $i.object({
      [kSymbolField]: Dep1,
    }),
  ])
  class SymbolKeyed {
    constructor(readonly args: { [kSymbolField]: Dep1 }) {}
  }

  it('should resolve argument bag in same well it would resolve normal args', async function () {
    const di = new CaffeineIoC()
    await di.init()
    const root = di.get(Root)

    expect(root)
      .toBeInstanceOf(Root)
    expect(root.args.dep1)
      .toBeInstanceOf(Dep1)
    expect(root.args.dep2)
      .toBeUndefined()
    expect(root.args.dep3)
      .toBeInstanceOf(Dep3)
    expect(root.args.base)
      .toHaveLength(2)
    expect(root.args.base.every(x => x instanceof Base))
      .toBeTruthy()
  })

  it('should resolve constructor mixing different argument types', async function () {
    const di = new CaffeineIoC()
    await di.init()
    const diff = di.get(DiffTypes)

    expect(diff)
      .toBeInstanceOf(DiffTypes)
    expect(diff.args.dep1)
      .toBeInstanceOf(Dep1)
    expect(diff.dep2)
      .toBeUndefined()
    expect(diff.other.dep3)
      .toBeInstanceOf(Dep3)
    expect(diff.base)
      .toHaveLength(2)
    expect(diff.base.every(x => x instanceof Base))
      .toBeTruthy()
    expect(diff.another.base)
      .toHaveLength(2)
    expect(diff.another.base.every(x => x instanceof Base))
      .toBeTruthy()
  })

  it('should resolve deep nested destructuring bags', async function () {
    const di = new CaffeineIoC()
    await di.init()
    const nested = di.get(Nested)

    expect(nested)
      .toBeInstanceOf(Nested)
    expect(nested.args.services.db)
      .toBeInstanceOf(Dep1)
    expect(nested.args.services.cache)
      .toBeUndefined()
    expect(nested.args.config.auth.token)
      .toBeInstanceOf(Dep3)
  })

  it('should resolve symbol-keyed fields in destructuring bag', async function () {
    const di = new CaffeineIoC()
    await di.init()
    const sym = di.get(SymbolKeyed)

    expect(sym)
      .toBeInstanceOf(SymbolKeyed)
    expect(sym.args[kSymbolField])
      .toBeInstanceOf(Dep1)
  })
})
