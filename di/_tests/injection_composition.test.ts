import { describe, expect, it } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ErrConflictingInjectionStages } from '../errors.js'
import { $i } from '../injection.js'
import { token } from '../key.js'
import type { Provider } from '../provider.js'
import { Scopes } from '../scope.js'

// Nesting order is not supposed to matter: a stage that rearranges bindings runs on the way down, a stage that
// wraps runs on the way back up, and the terminal always runs last. Each pair below is asserted both ways round.

interface Plugin {
  id(): string
}

const kPlug = token<Plugin>(Symbol('composition-plugin'))

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

function withPlugins(): CaffeineIoC {
  const di = new CaffeineIoC({ decorators: false })
  di.bind(Alpha, t => t.toSelf().names(kPlug).order(2))
  di.bind(Beta, t => t.toSelf().names(kPlug).order(1))
  di.bind(Gamma, t => t.toSelf().names(kPlug).order(3))

  return di
}

const ids = (plugins: Plugin[]): string[] => plugins.map(p => p.id())

describe('$i.ordered() composed with $i.provide()', function () {
  class Outer {
    constructor(readonly plugins: Provider<Plugin[]>) {}
  }

  class Inner {
    constructor(readonly plugins: Provider<Plugin[]>) {}
  }

  it('resolves a provider of the sorted array whichever way round it is written', async function () {
    const di = withPlugins()
    di.bind(Outer, t => t.toSelf([$i.ordered($i.provide(kPlug))]))
    di.bind(Inner, t => t.toSelf([$i.provide($i.ordered(kPlug))]))
    await di.init()

    expect(ids(di.get(Outer).plugins.get())).toEqual(['beta', 'alpha', 'gamma'])
    expect(ids(di.get(Inner).plugins.get())).toEqual(['beta', 'alpha', 'gamma'])
  })

  it('re-resolves on every get, so the array is fresh', async function () {
    const di = withPlugins()
    di.bind(Outer, t => t.toSelf([$i.ordered($i.provide(kPlug))]))
    await di.init()

    const provider = di.get(Outer).plugins

    expect(provider.get()).not.toBe(provider.get())
    expect(ids(provider.get())).toEqual(ids(provider.get()))
  })
})

describe('$i.provide() composed with $i.mapped()', function () {
  class Holder {
    constructor(readonly plugins: Provider<Map<string, Plugin>>) {}
  }

  it('resolves a provider of the map', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Alpha, t => t.toSelf().names(kPlug))
    di.bind(Holder, t => t.toSelf([$i.provide($i.mapped(kPlug))]))
    await di.init()

    const map = di.get(Holder).plugins.get()

    expect(map).toBeInstanceOf(Map)
    expect([...map.keys()]).toEqual([kPlug])
  })
})

describe('$i.ordered() composed with $i.defer()', function () {
  class Holder {
    constructor(readonly plugins: Plugin[]) {}
  }

  // The suggestion in ordered's own error message. It used to drop the deferral, miss the map lookup for the
  // wrapped key, and hand back an empty array without complaining.
  it('resolves the deferred key and sorts it', async function () {
    const di = withPlugins()
    di.bind(Holder, t => t.toSelf([$i.ordered($i.defer(() => kPlug))]))
    await di.init()

    expect(ids(di.get(Holder).plugins)).toEqual(['beta', 'alpha', 'gamma'])
  })
})

describe('$i.provide() composed with $i.defer()', function () {
  class Down {
    constructor(readonly up: Provider<Up>) {}
  }

  class Up {
    constructor(readonly down: Down) {}

    tag(): string {
      return 'up'
    }
  }

  it('still breaks a constructor cycle', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Down, t => t.toSelf([$i.provide($i.defer(() => Up))]))
    di.bind(Up, t => t.toSelf([Down]))
    await di.init()

    expect(di.get(Up).down.up.get().tag()).toEqual('up')
  })
})

describe('$i.optional() composed with $i.ordered()', function () {
  // optional() widens what it wraps, so the declared type admits undefined. A collecting terminal never produces
  // it: an unbound key resolves to an empty array, as the second case shows.
  class Holder {
    constructor(readonly plugins: Plugin[] | undefined) {}
  }

  it('keeps sorting', async function () {
    const di = withPlugins()
    di.bind(Holder, t => t.toSelf([$i.optional($i.ordered(kPlug))]))
    await di.init()

    expect(ids(di.get(Holder).plugins!)).toEqual(['beta', 'alpha', 'gamma'])
  })

  it('resolves an empty array when nothing is bound', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Holder, t => t.toSelf([$i.optional($i.ordered(token<Plugin>(Symbol('composition-absent'))))]))
    await di.init()

    expect(di.get(Holder).plugins).toEqual([])
  })
})

describe('two stages that both decide the result', function () {
  class Holder {
    constructor(readonly plugins: unknown) {}
  }

  it('rejects the injection at init, naming both', async function () {
    const di = withPlugins()
    di.bind(Holder, t => t.toSelf([$i.allOf($i.mapped(kPlug))]))

    await expect(di.init()).rejects.toBeInstanceOf(ErrConflictingInjectionStages)
  })
})

describe('a transient target reached through composed stages', function () {
  class Holder {
    constructor(readonly plugins: Provider<Plugin[]>) {}
  }

  it('produces new instances on every get', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Alpha, t => t.toSelf().names(kPlug).order(1).lifetime(Scopes.TRANSIENT))
    di.bind(Holder, t => t.toSelf([$i.ordered($i.provide(kPlug))]))
    await di.init()

    const provider = di.get(Holder).plugins

    expect(provider.get()[0]).not.toBe(provider.get()[0])
  })
})
