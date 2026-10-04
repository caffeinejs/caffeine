import { describe, expect, it } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ErrInvalidContainerState, ErrNoValuesProvider } from '../errors.js'
import { $i } from '../injection.js'
import type { Provider } from '../provider.js'
import { Scopes } from '../scope.js'

type Cfg = { database: { host: string; port?: number } }

// What a configuration store hands the container: one object per revision, swapped, never mutated.
function revisions(first: Cfg) {
  let current = first
  const provider: Provider<Cfg> = { get: () => current }
  return {
    provider,
    swap(next: Cfg) {
      current = next
    },
  }
}

describe('bindScopedConfig', function () {
  it('makes reading the scoped config throw ErrNoValuesProvider, naming bindScopedConfig, when nothing was bound', function () {
    const di = new CaffeineIoC({ decorators: false })
    const read = () => di.scopedConfig

    expect(di.hasScopedConfig).toBe(false)
    expect(read).toThrow(ErrNoValuesProvider)
    expect(read).toThrow(/call bindScopedConfig\(\) before init\(\)$/)
  })

  it('holds the provider it is given', async function () {
    const { provider } = revisions({ database: { host: 'a' } })
    const di = new CaffeineIoC({ decorators: false })

    expect(di.bindScopedConfig(provider)).toBe(di)
    expect(di.hasScopedConfig).toBe(true)

    await di.init()

    expect(di.scopedConfig).toBe(provider)
  })

  it('rejects undefined and null', function () {
    const di = new CaffeineIoC({ decorators: false })

    expect(() => di.bindScopedConfig(undefined as never)).toThrow('Parameter provider must not be null or undefined')
    expect(() => di.bindScopedConfig(null as never)).toThrow('Parameter provider must not be null or undefined')
    expect(di.hasScopedConfig).toBe(false)
  })

  // A consumer compiled against no provider would never see one bound later.
  it('is refused once the container compiled', async function () {
    const di = new CaffeineIoC({ decorators: false })
    await di.init()

    expect(() => di.bindScopedConfig({ get: () => ({}) })).toThrow(ErrInvalidContainerState)
  })

  it('travels with a snapshot into another container', async function () {
    const { provider } = revisions({ database: { host: 'a' } })
    const source = new CaffeineIoC({ decorators: false })
    source.bindScopedConfig(provider)

    const target = new CaffeineIoC({ decorators: false })
    target.restore(source.snapshot())
    await target.init()

    expect(target.scopedConfig).toBe(provider)
  })
})

describe('$i.liveConfig', function () {
  // The reason it exists: a singleton is built once, and $i.config would freeze the value it read then.
  it('lets a singleton read the value the scoped config holds now, not the one it was built with', async function () {
    const { provider, swap } = revisions({ database: { host: 'first' } })

    class Repo {
      constructor(readonly host: Provider<string>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bindScopedConfig(provider)
    di.bind(Repo, t => t.toClass(Repo, [$i.liveConfig<Cfg>(c => c.database.host)]).lifetime(Scopes.SINGLETON))
    await di.init()

    const repo = di.get(Repo)
    expect(repo.host.get()).toBe('first')

    swap({ database: { host: 'second' } })

    expect(di.get(Repo)).toBe(repo)
    expect(repo.host.get()).toBe('second')
  })

  // A provider re-reads by itself, so injecting it into a singleton captures nothing the scope check guards.
  it('passes the default scope check in a singleton', async function () {
    class Repo {
      constructor(readonly host: Provider<string>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bindScopedConfig({ get: () => ({ database: { host: 'h' } }) })
    di.bind(Repo, t => t.toClass(Repo, [$i.liveConfig<Cfg>(c => c.database.host)]))

    await expect(di.init()).resolves.toBeUndefined()
  })

  it('selects by dot path', async function () {
    const { provider, swap } = revisions({ database: { host: 'first' } })

    class Repo {
      constructor(readonly host: Provider<string>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bindScopedConfig(provider)
    di.bind(Repo, t => t.toClass(Repo, [$i.liveConfig('database.host')]))
    await di.init()

    swap({ database: { host: 'second' } })

    expect(di.get(Repo).host.get()).toBe('second')
  })

  it('answers the default while the selected value is undefined, and the value once it is set', async function () {
    const { provider, swap } = revisions({ database: { host: 'h' } })

    class Repo {
      constructor(readonly port: Provider<number>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bindScopedConfig(provider)
    di.bind(Repo, t => t.toClass(Repo, [$i.liveConfig<Cfg>(c => c.database.port, 5432)]))
    await di.init()

    const port = di.get(Repo).port
    expect(port.get()).toBe(5432)

    swap({ database: { host: 'h', port: 6543 } })
    expect(port.get()).toBe(6543)
  })

  it('fails init with ErrNoValuesProvider, naming the injection site, when no provider is bound', async function () {
    class Repo {
      constructor(readonly host: Provider<string>) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Repo, t => t.toClass(Repo, [$i.liveConfig<Cfg>(c => c.database.host)]))
    const init = di.init()

    await expect(init).rejects.toThrow(ErrNoValuesProvider)
    await expect(init).rejects.toThrow(/bindScopedConfig\(\)/)
  })

  it('still delivers a provider when nothing is bound and the injection is optional or has a default', async function () {
    class Repo {
      constructor(
        readonly host: Provider<string | undefined>,
        readonly port: Provider<number>,
      ) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Repo, t =>
      t.toClass(Repo, [
        $i.optional($i.liveConfig<Cfg>(c => c.database.host)),
        $i.liveConfig<Cfg>(c => c.database.port, 5432),
      ]),
    )
    await di.init()

    const repo = di.get(Repo)
    expect(repo.host.get()).toBeUndefined()
    expect(repo.port.get()).toBe(5432)
  })
})
