import '../index.nodejs.js'
import { randomUUID } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ErrMissingInjectionKey, ErrNoResolutionForKey, ErrNoUniqueInjectionForKey, ErrOutOfScope } from '../errors.js'
import { $i } from '../injection.js'
import { token } from '../key.js'
import type { Provider } from '../provider.js'
import { Scopes } from '../scope.js'

// `$i.provide()` is the only injection the scope validator skips, so nothing else in the suite notices if the
// wrapper stops re-reading its binding. Everything below is one assertion of the same contract: the `Provider`
// object is built once, and the value behind it is whatever the target binding's scope answers at read time.

describe('$i.provide() — the resolved value follows the target lifetime', function () {
  it('gives a new instance on every get() when the target is transient', async function () {
    const created = vi.fn()

    class Dep {
      readonly id: string = randomUUID()

      constructor() {
        created()
      }
    }

    class Holder {
      constructor(readonly dep: Provider<Dep>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Dep, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    di.bind(Holder, t => t.toSelf([$i.provide(Dep)]))
    await di.init()

    const holder = di.get(Holder)
    const first = holder.dep.get()
    const second = holder.dep.get()

    expect(first).not.toBe(second)
    expect(first.id).not.toEqual(second.id)
    expect(created).toHaveBeenCalledTimes(2)

    await di.dispose()
  })

  it('gives the cached instance on every get() when the target is a singleton', async function () {
    const created = vi.fn()

    class Dep {
      constructor() {
        created()
      }
    }

    class Holder {
      constructor(readonly dep: Provider<Dep>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Dep, t => t.toSelf())
    di.bind(Holder, t => t.toSelf([$i.provide(Dep)]))
    await di.init()

    const holder = di.get(Holder)

    expect(holder.dep.get()).toBe(holder.dep.get())
    expect(created).toHaveBeenCalledTimes(1)

    await di.dispose()
  })

  it('picks up the new instance after refresher.refresh() when the target is refresh-scoped', async function () {
    class Dep {
      readonly id: string = randomUUID()
    }

    class Holder {
      constructor(readonly dep: Provider<Dep>) {}
    }

    // Injects the same dependency directly, so the two are only telling apart what `$i.provide()` buys.
    class Captor {
      constructor(readonly dep: Dep) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Dep, t => t.toSelf().lifetime(Scopes.REFRESH))
    di.bind(Holder, t => t.toSelf([$i.provide(Dep)]))
    di.bind(Captor, t => t.toSelf([Dep]))
    await di.init()

    const holder = di.get(Holder)
    const captor = di.get(Captor)
    const before = holder.dep.get()

    expect(holder.dep.get()).toBe(before)
    expect(captor.dep).toBe(before)

    await di.refresher.refresh()

    expect(holder.dep.get()).not.toBe(before)
    expect(captor.dep).toBe(before)

    await di.dispose()
  })
})

describe('$i.provide() — mixing scopes', function () {
  class Transient {
    readonly id: string = randomUUID()
  }

  it('lets a singleton read a fresh transient on every get()', async function () {
    class Holder {
      constructor(readonly dep: Provider<Transient>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Transient, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    di.bind(Holder, t => t.toSelf([$i.provide(Transient)]))
    await di.init()

    const holder = di.get(Holder)

    expect(di.get(Holder)).toBe(holder)
    expect(holder.dep.get()).not.toBe(holder.dep.get())

    await di.dispose()
  })

  // The same graph without the wrapper: the check has to be switched off to even build it, and the singleton
  // then holds one transient instance forever. That is the whole reason `$i.provide()` exists.
  it('freezes one transient instance for the singleton lifetime without $i.provide()', async function () {
    class Holder {
      constructor(readonly dep: Transient) {}
    }

    const di = new CaffeineIoC({ decorators: false, checks: { scopes: 'off' } })
    di.bind(Transient, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    di.bind(Holder, t => t.toSelf([Transient]))
    await di.init()

    const holder = di.get(Holder)

    expect(holder.dep).toBe(holder.dep)
    expect(di.get(Holder).dep).toBe(holder.dep)

    await di.dispose()
  })

  it('lets separate transient consumers share one singleton target', async function () {
    class Dep {}

    class Holder {
      constructor(readonly dep: Provider<Dep>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Dep, t => t.toSelf())
    di.bind(Holder, t => t.toSelf([$i.provide(Dep)]).lifetime(Scopes.TRANSIENT))
    await di.init()

    const first = di.get(Holder)
    const second = di.get(Holder)

    expect(first).not.toBe(second)
    expect(first.dep.get()).toBe(second.dep.get())

    await di.dispose()
  })
})

describe('$i.provide() — a singleton holding a request-scoped target', function () {
  class Dep {
    readonly id: string = randomUUID()
  }

  class Holder {
    constructor(readonly dep: Provider<Dep>) {}
  }

  function containerWithRequestScopedDep(): CaffeineIoC {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Dep, t => t.toSelf().lifetime(Scopes.REQUEST))
    di.bind(Holder, t => t.toSelf([$i.provide(Dep)]))

    return di
  }

  it('resolves one instance per request and a different one in the next request', async function () {
    const di = containerWithRequestScopedDep()
    await di.init()

    const holder = di.get(Holder)

    const first = await di.requestScopeManager.run(() => {
      const instance = holder.dep.get()
      expect(holder.dep.get()).toBe(instance)

      return instance.id
    })
    const second = await di.requestScopeManager.run(() => holder.dep.get().id)

    expect(first).not.toEqual(second)

    await di.dispose()
  })

  it('throws ErrOutOfScope when get() is called outside a request', async function () {
    const di = containerWithRequestScopedDep()
    await di.init()

    const holder = di.get(Holder)

    expect(() => holder.dep.get()).toThrow(ErrOutOfScope)

    await di.dispose()
  })
})

describe('$i.provide() — the Provider wrapper itself', function () {
  class Dep {
    readonly id: string = randomUUID()
  }

  class Holder {
    constructor(readonly dep: Provider<Dep>) {}
  }

  async function container(): Promise<CaffeineIoC> {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Dep, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    di.bind(Holder, t => t.toSelf([$i.provide(Dep)]).lifetime(Scopes.TRANSIENT))
    await di.init()

    return di
  }

  it('is one object shared by every consumer instance, even when the consumer is transient', async function () {
    const di = await container()
    const first = di.get(Holder)
    const second = di.get(Holder)

    expect(first).not.toBe(second)
    expect(first.dep).toBe(second.dep)
    expect(first.dep.get()).not.toBe(second.dep.get())

    await di.dispose()
  })

  it('exposes get() and nothing else', async function () {
    const di = await container()

    expect(Object.keys(di.get(Holder).dep)).toEqual(['get'])

    await di.dispose()
  })
})

describe('$i.allOf($i.provide())', function () {
  interface Plugin {
    id: string
  }

  const kPlugin = token<Plugin>(Symbol('provider-injection-plugin'))

  class Stable implements Plugin {
    readonly id: string = randomUUID()
  }

  class Fresh implements Plugin {
    readonly id: string = randomUUID()
  }

  it('returns a new array whose elements each follow their own binding lifetime', async function () {
    class Holder {
      constructor(readonly plugins: Provider<Plugin[]>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Stable, t => t.toSelf().names(kPlugin))
    di.bind(Fresh, t => t.toSelf().names(kPlugin).lifetime(Scopes.TRANSIENT))
    di.bind(Holder, t => t.toSelf([$i.allOf($i.provide(kPlugin))]))
    await di.init()

    const holder = di.get(Holder)
    const first = holder.plugins.get()
    const second = holder.plugins.get()

    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    expect(first).not.toBe(second)
    expect(second.find(p => p instanceof Stable)).toBe(first.find(p => p instanceof Stable))
    expect(second.find(p => p instanceof Fresh)).not.toBe(first.find(p => p instanceof Fresh))

    await di.dispose()
  })

  it('leaves the consumer own binding out of the list it collects', async function () {
    class Selfish implements Plugin {
      readonly id: string = randomUUID()

      constructor(readonly others: Provider<Plugin[]>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Stable, t => t.toSelf().names(kPlugin))
    di.bind(Selfish, t => t.toSelf([$i.allOf($i.provide(kPlugin))]).names(kPlugin))
    await di.init()

    const collected = di.get(Selfish).others.get()

    expect(collected).toHaveLength(1)
    expect(collected[0]).toBeInstanceOf(Stable)

    await di.dispose()
  })

  it('returns an empty array when no binding matches the key', async function () {
    const kEmpty = token<Plugin>(Symbol('provider-injection-empty'))

    class Holder {
      constructor(readonly plugins: Provider<Plugin[]>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Holder, t => t.toSelf([$i.allOf($i.provide(kEmpty))]))
    await di.init()

    expect(di.get(Holder).plugins.get()).toEqual([])

    await di.dispose()
  })
})

describe('$i.provide() — missing and ambiguous targets', function () {
  const kMissing = token<{ id: string }>(Symbol('provider-injection-missing'))

  it('resolves undefined on every get() when the target is missing and optional', async function () {
    class Holder {
      constructor(readonly dep: Provider<{ id: string } | undefined>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Holder, t => t.toSelf([$i.optional($i.provide(kMissing))]))
    await di.init()

    const holder = di.get(Holder)

    expect(holder.dep.get()).toBeUndefined()
    expect(holder.dep.get()).toBeUndefined()

    await di.dispose()
  })

  it('rejects init() with ErrNoResolutionForKey when the target is missing', async function () {
    class Holder {
      constructor(readonly dep: Provider<{ id: string }>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Holder, t => t.toSelf([$i.provide(kMissing)]))

    await expect(di.init()).rejects.toBeInstanceOf(ErrNoResolutionForKey)
  })

  it('rejects init() with ErrNoUniqueInjectionForKey when the key has more than one binding', async function () {
    const kAmbiguous = token<{ id: string }>(Symbol('provider-injection-ambiguous'))

    class First {
      readonly id: string = randomUUID()
    }

    class Second {
      readonly id: string = randomUUID()
    }

    class Holder {
      constructor(readonly dep: Provider<{ id: string }>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(First, t => t.toSelf().names(kAmbiguous))
    di.bind(Second, t => t.toSelf().names(kAmbiguous))
    di.bind(Holder, t => t.toSelf([$i.provide(kAmbiguous)]))

    await expect(di.init()).rejects.toBeInstanceOf(ErrNoUniqueInjectionForKey)
  })

  it('throws ErrMissingInjectionKey for a descriptor carrying no key', function () {
    expect(() => $i.provide({ stages: [] } as never)).toThrow(ErrMissingInjectionKey)
  })
})

describe('$i.provide($i.defer())', function () {
  it('breaks a constructor cycle and resolves the deferred target on get()', async function () {
    class Down {
      constructor(readonly up: Provider<Up>) {}
    }

    class Up {
      constructor(readonly down: Down) {}

      tag(): string {
        return 'up'
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Down, t => t.toSelf([$i.provide($i.defer(() => Up))]))
    di.bind(Up, t => t.toSelf([Down]))
    await di.init()

    const up = di.get(Up)

    expect(up.down).toBeInstanceOf(Down)
    expect(up.down.up.get().tag()).toEqual('up')

    await di.dispose()
  })

  it('resolves through the container on every read, so a transient target stays fresh', async function () {
    class Dep {
      readonly id: string = randomUUID()
    }

    class Holder {
      constructor(readonly dep: Provider<Dep>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Dep, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    di.bind(Holder, t => t.toSelf([$i.provide($i.defer(() => Dep))]))
    await di.init()

    const holder = di.get(Holder)

    expect(holder.dep.get().id).not.toEqual(holder.dep.get().id)

    await di.dispose()
  })
})

describe('$i.provide() inside $i.object()', function () {
  it('delivers the same wrapper on repeated field reads while the value stays fresh', async function () {
    class Dep {
      readonly id: string = randomUUID()
    }

    class Holder {
      constructor(readonly bag: { dep: Provider<Dep> }) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Dep, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    di.bind(Holder, t => t.toSelf([$i.object({ dep: $i.provide(Dep) })]))
    await di.init()

    const holder = di.get(Holder)

    expect(holder.bag.dep).toBe(holder.bag.dep)
    expect(holder.bag.dep.get()).not.toBe(holder.bag.dep.get())

    await di.dispose()
  })
})

describe('$i.provide() — binding lookup happens at compile time', function () {
  it('resolves the replacement when the target key is rebound before init()', async function () {
    class Original {
      tag(): string {
        return 'original'
      }
    }

    class Replacement extends Original {
      override tag(): string {
        return 'replacement'
      }
    }

    class Holder {
      constructor(readonly dep: Provider<Original>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Original, t => t.toSelf())
    di.bind(Holder, t => t.toSelf([$i.provide(Original)]))
    di.rebind(Original, t => t.toClass(Replacement))
    await di.init()

    expect(di.get(Holder).dep.get().tag()).toEqual('replacement')

    await di.dispose()
  })
})
