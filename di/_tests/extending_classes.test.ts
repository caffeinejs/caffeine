import { randomUUID } from 'node:crypto'

import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Extends } from '../decorators/extends.js'
import { Injectable } from '../decorators/injectable.js'
import { Lifetime } from '../decorators/lifetime.js'
import { Named } from '../decorators/named.js'
import { Primary } from '../decorators/primary.js'
import { ErrInvalidBinding, ErrInvalidDecorator } from '../errors.js'
import { $i } from '../injection.js'
import { token } from '../key.js'
import { Scopes } from '../scope.js'

describe('Abstract Classes', function () {
  describe('when binding a concrete class to an abstract class as a key', function () {
    abstract class Base {
      abstract test(): string
    }

    @Injectable()
    @Extends(Base)
    class Impl extends Base {
      readonly id: string = randomUUID()

      test(): string {
        return 'ok'
      }
    }

    it('should resolve instance via the abstract class key', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const impl1 = di.get(Base) as Impl
      const impl2 = di.get(Base) as Impl

      expect(impl1).toBeInstanceOf(Impl)
      expect(impl1).toBeInstanceOf(Base)
      expect(impl1.test()).toEqual('ok')
      expect(impl1.id).toEqual(impl2.id)
    })

    it('should inject abstract key as a constructor dependency', async function () {
      @Injectable([Base])
      class Service {
        constructor(readonly dep: Base) {}
      }

      const di = new CaffeineIoC()
      await di.init()
      const service = di.get(Service)

      expect(service.dep).toBeInstanceOf(Impl)
      expect(service.dep).toBeInstanceOf(Base)
      expect(service.dep.test()).toEqual('ok')
    })
  })

  describe('when extending an abstract class with a transient scope', function () {
    abstract class Base {
      readonly id: string = randomUUID()
    }

    @Injectable()
    @Extends(Base)
    @Lifetime(Scopes.TRANSIENT)
    class Impl extends Base {}
    void Impl

    it('should respect the scope of the concrete class', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const a = di.get(Base)
      const b = di.get(Base)

      expect(a.id).not.toEqual(b.id)
    })
  })

  describe('given multiple implementations of an abstract class', function () {
    const kMongo = token<Repo>(Symbol.for('mongodb'))
    const kSql = token<Repo>(Symbol.for('sql'))
    const kAll = token<Repo>(Symbol('all-repos'))

    abstract class Repo {
      abstract list(): string
    }

    @Injectable()
    @Named(kSql)
    @Named(kAll)
    @Extends()
    class MySqlRepo extends Repo {
      list(): string {
        return 'mysql'
      }
    }
    void MySqlRepo

    @Injectable()
    @Named(kMongo, kAll)
    @Extends(Repo)
    @Primary()
    class MongoRepo extends Repo {
      list(): string {
        return 'mongodb'
      }
    }

    it('should inject a specific implementation by name', async function () {
      @Injectable([kMongo])
      class DbService {
        constructor(readonly repo: Repo) {}
      }

      const di = new CaffeineIoC()
      await di.init()

      const service = di.get<DbService>(DbService)

      expect(service.repo).toBeInstanceOf(MongoRepo)
      expect(service.repo.list()).toEqual('mongodb')
    })

    it('should inject the primary implementation when requesting a single dependency by the abstract class key', async function () {
      @Injectable([Repo])
      class DbService {
        constructor(readonly repo: Repo) {}
      }

      const di = new CaffeineIoC()
      await di.init()

      const service = di.get<DbService>(DbService)

      expect(service.repo).toBeInstanceOf(MongoRepo)
      expect(service.repo.list()).toEqual('mongodb')
    })

    it('should inject all implementations by the abstract class key', async function () {
      @Injectable([$i.allOf(Repo)])
      class DbService {
        constructor(readonly repos: Repo[]) {}
      }

      const di = new CaffeineIoC()
      await di.init()

      const service = di.get<DbService>(DbService)

      expect(service.repos).toHaveLength(2)
      expect(service.repos.map(r => r.list()).sort()).toEqual(['mongodb', 'mysql'])

      const repos = di.getMany(Repo)

      expect(repos).toHaveLength(2)
      expect(repos.map(r => r.list()).sort()).toEqual(['mongodb', 'mysql'])
    })

    it('should inject all named implementations ', async function () {
      @Injectable([$i.allOf(kAll)])
      class AllRepoService {
        constructor(readonly repos: Repo[]) {}
      }

      const di = new CaffeineIoC()
      await di.init()

      const service = di.get(AllRepoService)

      expect(service.repos).toHaveLength(2)
      expect(service.repos.map(r => r.list()).sort()).toEqual(['mongodb', 'mysql'])
    })

    describe('when mixing injections', function () {
      it('should resolve the dependencies following the injection specification', async function () {
        @Injectable([Repo, kSql, $i.allOf(Repo), $i.allOf(kAll)])
        class DbService {
          constructor(
            readonly repo: Repo,
            readonly byName: Repo,
            readonly byAbstract: Repo[],
            readonly byAll: Repo[],
          ) {}
        }

        const di = new CaffeineIoC()
        await di.init()

        const service = di.get(DbService)

        expect(service.repo).toBeInstanceOf(MongoRepo)
        expect(service.byName).toBeInstanceOf(MySqlRepo)
        expect(service.byAbstract).toHaveLength(2)
        expect(service.byAbstract.map(r => r.list()).sort()).toEqual(['mongodb', 'mysql'])
        expect(service.byAll).toHaveLength(2)
        expect(service.byAll.map(r => r.list()).sort()).toEqual(['mongodb', 'mysql'])
      })
    })
  })

  describe('when using the parameterless form of @Extends', function () {
    it('should infer the abstract base from the class extends', async function () {
      abstract class Repo {
        abstract list(): string
      }

      @Injectable()
      @Extends()
      class InMemoryRepo extends Repo {
        list(): string {
          return 'ok'
        }
      }
      void InMemoryRepo

      const di = new CaffeineIoC()
      await di.init()
      const repo = di.get(Repo)

      expect(repo).toBeInstanceOf(InMemoryRepo)
      expect(repo.list()).toEqual('ok')
    })

    it('should throw when the class has no explicit base', function () {
      expect(() => {
        @Injectable()
        @Extends()
        class Impl {}
        void Impl
      }).toThrow(ErrInvalidDecorator)
    })
  })

  describe('when using only @Extends without @Injectable', function () {
    abstract class Repo {
      abstract list(): string
    }

    @Extends()
    @Named('in-memory')
    @Primary()
    class InMemoryRepo extends Repo {
      list(): string {
        return 'in-memory'
      }
    }

    @Extends()
    @Named('mysql')
    class MySqlRepo extends Repo {
      list(): string {
        return 'mysql'
      }
    }

    @Injectable([InMemoryRepo, MySqlRepo, $i.allOf(Repo), Repo])
    class Service {
      constructor(
        readonly inMemory: InMemoryRepo,
        readonly mysql: MySqlRepo,
        readonly all: Repo[],
        readonly single: Repo,
      ) {}
    }

    void InMemoryRepo
    void MySqlRepo
    void Service

    it('should resolve the concrete class via the abstract key', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const repo = di.get(Repo)

      expect(repo).toBeInstanceOf(InMemoryRepo)
      expect(repo.list()).toEqual('in-memory')
    })

    it('should resolve the primary implementation when requesting a single dependency by the abstract key', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const repo = di.get(Repo)

      expect(repo).toBeInstanceOf(InMemoryRepo)
      expect(repo.list()).toEqual('in-memory')
    })

    it('should inject all implementations by the abstract key', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const repos = di.getMany(Repo)

      expect(repos).toHaveLength(2)
      expect(repos.map(r => r.list()).sort()).toEqual(['in-memory', 'mysql'])
    })

    it('should resolve the dependencies following the injection specification', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const service = di.get(Service)

      expect(service.inMemory).toBeInstanceOf(InMemoryRepo)
      expect(service.mysql).toBeInstanceOf(MySqlRepo)
      expect(service.all).toHaveLength(2)
      expect(service.all.map(r => r.list()).sort()).toEqual(['in-memory', 'mysql'])
      expect(service.single).toBeInstanceOf(InMemoryRepo)
    })
  })

  describe('when manually binding an abstract class', function () {
    describe('basic resolution', function () {
      abstract class Store {
        abstract fetch(): string
      }

      class MemStore extends Store {
        fetch(): string {
          return 'mem'
        }
      }

      it('should resolve the concrete class via the abstract key', async function () {
        const di = new CaffeineIoC()
        di.bind(MemStore, t => t.toSelf().extends(Store))
        await di.init()

        const result = di.get(Store)

        expect(result).toBeInstanceOf(MemStore)
        expect(result.fetch()).toEqual('mem')
      })

      it('should return the same singleton instance via both the concrete and abstract key', async function () {
        const di = new CaffeineIoC()
        di.bind(MemStore, t => t.toSelf().extends(Store))
        await di.init()

        const viaAbstract = di.get(Store)
        const viaConcrete = di.get(MemStore)

        expect(viaAbstract).toBe(viaConcrete)
      })
    })

    describe('transient scope', function () {
      abstract class IdBase {
        readonly id: string = randomUUID()
      }

      class IdImpl extends IdBase {}

      it('should produce a new instance on each resolution via the abstract key', async function () {
        const di = new CaffeineIoC()
        di.bind(IdImpl, t => t.toSelf().lifetime(Scopes.TRANSIENT).extends(IdBase))
        await di.init()

        const a = di.get(IdBase)
        const b = di.get(IdBase)

        expect(a.id).not.toEqual(b.id)
      })
    })

    describe('multiple implementations', function () {
      abstract class Cache {
        abstract get(): string
      }

      class MemCache extends Cache {
        get(): string {
          return 'mem'
        }
      }

      class RedisCache extends Cache {
        get(): string {
          return 'redis'
        }
      }

      it('should resolve the primary implementation when requesting by abstract key', async function () {
        const di = new CaffeineIoC()
        di.bind(MemCache, t => t.toSelf().extends(Cache))
        di.bind(RedisCache, t => t.toSelf().extends(Cache).primary())
        await di.init()

        const cache = di.get(Cache)

        expect(cache).toBeInstanceOf(RedisCache)
      })

      it('should resolve all implementations via getMany', async function () {
        const di = new CaffeineIoC()
        di.bind(MemCache, t => t.toSelf().extends(Cache))
        di.bind(RedisCache, t => t.toSelf().extends(Cache))
        await di.init()

        const all = di.getMany(Cache)

        expect(all).toHaveLength(2)
        expect(all.map(c => c.get()).sort()).toEqual(['mem', 'redis'])
      })
    })

    describe('error cases', function () {
      abstract class Base {}

      class Unrelated {}

      it('should throw when the concrete class does not extend the given base', function () {
        const di = new CaffeineIoC()

        expect(() => di.bind(Unrelated, t => t.toSelf().extends(Base))).toThrow(ErrInvalidBinding)
      })

      it('should throw when base is not a class reference', function () {
        class Impl extends Base {}

        const di = new CaffeineIoC()

        expect(() => di.bind(Impl, t => t.toSelf().extends('not-a-class' as any))).toThrow(ErrInvalidBinding)
      })
    })
  })

  describe('auto-extend via @Injectable', function () {
    abstract class AutoExtendBase {
      abstract greet(): string
    }

    @Injectable()
    class AutoExtendChild extends AutoExtendBase {
      greet(): string {
        return 'child'
      }
    }

    it('registers the class under its abstract base key automatically', async function () {
      const di = new CaffeineIoC()
      await di.init()

      expect(di.get(AutoExtendChild)).toBeInstanceOf(AutoExtendChild)
      expect(di.get(AutoExtendBase)).toBeInstanceOf(AutoExtendChild)
    })

    class ConcreteBase {
      greet(): string {
        return 'base'
      }
    }

    @Injectable()
    class ConcreteChild extends ConcreteBase {
      override greet(): string {
        return 'child'
      }
    }

    it('registers the class under a non-injectable concrete base key', async function () {
      const di = new CaffeineIoC()
      await di.init()

      expect(di.get(ConcreteChild)).toBeInstanceOf(ConcreteChild)
      expect(di.get(ConcreteBase)).toBeInstanceOf(ConcreteChild)
    })

    abstract class MultiBase {
      abstract id(): string
    }

    @Injectable()
    class MultiA extends MultiBase {
      id(): string {
        return 'A'
      }
    }

    @Primary()
    @Injectable()
    class MultiB extends MultiBase {
      id(): string {
        return 'B'
      }
    }

    it('resolves the @Primary child when multiple children share the same abstract base', async function () {
      const di = new CaffeineIoC()
      await di.init()

      expect(di.get(MultiBase).id()).toBe('B')
      expect(di.getMany(MultiBase)).toHaveLength(2)
    })
  })
})

// `has` and `get` used to read different indexes: `has` looked at the registry, which only holds directly
// bound keys, while `get` resolves through the binding index that `.extends()` also writes to. So a base
// key answered `false` to `has` and still resolved — which is how a framework default installed on
// `if (!container.has(Base))` got registered over a store the application had supplied.
describe('has() and a polymorphic binding', function () {
  abstract class HasBase {
    abstract id(): string
  }

  class HasChild extends HasBase {
    id(): string {
      return 'child'
    }
  }

  abstract class HasUnextended {
    abstract id(): string
  }

  it('reports a base key bound only through .extends() as present', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(HasChild, t => t.toSelf().extends(HasBase))
    await di.init()

    expect(di.has(HasBase)).toBe(true)
    expect(di.get(HasBase)).toBeInstanceOf(HasChild)
  })

  it('agrees with get() before the container is initialized', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(HasChild, t => t.toSelf().extends(HasBase))

    // `.extends()` maps the base while the chain is built, so the answer does not wait for init().
    expect(di.has(HasBase)).toBe(true)
  })

  it('still reports a base nothing extends as absent', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(HasChild, t => t.toSelf())
    await di.init()

    expect(di.has(HasUnextended)).toBe(false)
    expect(di.has(HasChild)).toBe(true)
  })
})
