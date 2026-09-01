import { describe, expect, it } from 'vitest'
import { CaffeineIoC } from '../container.js'
import { DeferredCtor } from '../deferred_ctor.js'
import { ErrNoResolutionForKey } from '../errors.js'
import { $i } from '../injection.js'
import { token } from '../key.js'
import type { Provider } from '../provider.js'
import { Scopes } from '../scope.js'

abstract class Plugin {
  abstract id(): string
}

class Alpha extends Plugin {
  id() {
    return 'alpha'
  }
}

class Beta extends Plugin {
  id() {
    return 'beta'
  }
}

class Singleton { }

class Transient { }

class Absent { }

const kMovie = token<{ title: string }>('movie')

// Every helper is exercised through `$i.object`, because that is the path that used to resolve fields with logic
// of its own rather than the resolver each helper names.
describe('$i.object', function () {
  async function container() {
    const di = new CaffeineIoC({ decorators: false })

    di.bind(Alpha).toSelf().extends(Plugin).order(1)
    di.bind(Beta).toSelf().extends(Plugin).order(2)
    di.bind(Singleton).toSelf()
    di.bind(Transient).toSelf().lifetime(Scopes.TRANSIENT)
    di.bindValuesProvider<{ database: { host: string, port: number } }>()
      .toValue({ database: { host: 'localhost', port: 5432 } })

    await di.init()

    return di
  }

  describe('given a constant', function () {
    it('should deliver it without consulting the container', async function () {
      const di = await container()
      const bag = di.resolver($i.object({ label: $i.just('pets'), count: $i.just(3) }))()

      expect(bag.label).toBe('pets')
      expect(bag.count).toBe(3)
    })
  })

  describe('given a value read from the values provider', function () {
    it('should select it by function, by path, and fall back to a default', async function () {
      const di = await container()
      const bag = di.resolver($i.object({
        host: $i.value<{ database: { host: string } }>(cfg => cfg.database.host),
        port: $i.value<{ database: { port: number } }>('database.port'),
        missing: $i.value<{ database: { host: string } }>('database.missing', 'fallback'),
      }))()

      expect(bag.host).toBe('localhost')
      expect(bag.port).toBe(5432)
      expect(bag.missing).toBe('fallback')
    })
  })

  describe('given a provider', function () {
    it('should deliver a Provider that resolves on every get', async function () {
      const di = await container()
      const bag = di.resolver($i.object({ transient: $i.provide(Transient) }))()

      const provider: Provider<Transient> = bag.transient

      expect(provider.get()).toBeInstanceOf(Transient)
      expect(provider.get()).not.toBe(provider.get())
    })
  })

  describe('given an ordered injection', function () {
    it('should deliver every binding, sorted by its order', async function () {
      const di = await container()
      const bag = di.resolver($i.object({ plugins: $i.ordered(Plugin) }))()

      expect(bag.plugins.map(p => p.id())).toEqual(['alpha', 'beta'])
    })
  })

  describe('given a mapped injection', function () {
    it('should deliver a Map keyed by the binding name', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(Alpha).toSelf().names(kMovie)
      await di.init()

      const bag = di.resolver($i.object({ movies: $i.mapped(kMovie) }))()

      expect(bag.movies).toBeInstanceOf(Map)
      expect([...bag.movies.keys()]).toEqual([kMovie])
    })
  })

  describe('given an object nested inside the spec', function () {
    it('should resolve it as a bag, written either way', async function () {
      const di = await container()
      const bag = di.resolver($i.object({
        explicit: $i.object({ singleton: Singleton, label: $i.just('inner') }),
        implicit: { singleton: Singleton },
      }))()

      expect(bag.explicit.singleton).toBeInstanceOf(Singleton)
      expect(bag.explicit.label).toBe('inner')
      expect(bag.implicit.singleton).toBeInstanceOf(Singleton)
    })
  })

  describe('given the helpers that already worked', function () {
    it('should keep resolving them the same way', async function () {
      const di = await container()
      const bag = di.resolver($i.object({
        singleton: Singleton,
        transient: Transient,
        absent: $i.optional(Absent),
        present: $i.optional(Singleton),
        all: $i.allOf(Plugin),
        deferred: $i.defer(() => Singleton),
      }))()

      expect(bag.singleton).toBeInstanceOf(Singleton)
      expect(bag.transient).toBeInstanceOf(Transient)
      expect(bag.absent).toBeUndefined()
      expect(bag.present).toBeInstanceOf(Singleton)
      expect(bag.all.map(p => p.id()).sort()).toEqual(['alpha', 'beta'])
      expect(bag.deferred).toBeInstanceOf(Singleton)
    })
  })

  describe('given a field that is read more than once', function () {
    it('should re-resolve through the binding, so one bag suits every scope', async function () {
      const di = await container()
      const bag = di.resolver($i.object({ singleton: Singleton, transient: Transient }))()

      expect(bag.singleton).toBe(bag.singleton)
      expect(bag.transient).not.toBe(bag.transient)
    })
  })

  describe('given a raw key as a field value', function () {
    it('should resolve it as an injection, in every form a key takes', async function () {
      const kNamed = token<Singleton>(Symbol('object-named-key'))
      const di = new CaffeineIoC({ decorators: false })
      di.bind(Singleton).toSelf().names(kNamed)
      await di.init()

      const bag = di.resolver($i.object({
        byClass: Singleton,
        byToken: kNamed,
        byDeferred: new DeferredCtor(() => Singleton),
      }))()

      expect(bag.byClass).toBeInstanceOf(Singleton)
      expect(bag.byToken).toBeInstanceOf(Singleton)
      expect(bag.byDeferred).toBeInstanceOf(Singleton)
    })
  })

  describe('given a hand-written descriptor literal', function () {
    it('should read it as a nested bag, since only a helper marks a descriptor', async function () {
      const di = await container()
      const bag = di.resolver($i.object({ cfg: { key: Singleton } }))()

      expect(bag.cfg.key).toBeInstanceOf(Singleton)
    })
  })

  describe('given a composed descriptor', function () {
    it('should still be recognised as one, not walked as a bag', async function () {
      const di = await container()
      const composed = $i.compose(Absent, k => $i.optional(k))
      const bag = di.resolver($i.object({ absent: composed }))()

      expect(bag.absent).toBeUndefined()
    })
  })

  describe('given a required field with no binding', function () {
    it('should say which field failed', async function () {
      const di = await container()

      expect(() => di.resolver($i.object({ outer: { inner: Absent } }))())
        .toThrow(ErrNoResolutionForKey)
      expect(() => di.resolver($i.object({ outer: { inner: Absent } }))())
        .toThrow(/outer\.inner/)
    })
  })
})
