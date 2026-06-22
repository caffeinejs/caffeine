import { describe, it, expect } from 'vitest'
import { v4 } from 'uuid'
import { Injectable } from '../decorators/injectable.js'
import { DiCaf } from '../container.js'

describe('interfaces', function () {
  describe('given an interface with multiple implementations and one of them using a named key', function () {
    const kRepo = Symbol('repo')

    interface Repository {
      save(): string
    }

    @Injectable()
    class InMemoryRepository implements Repository {
      save(): string {
        return 'in-memory'
      }
    }

    @Injectable(kRepo)
    class MySQLRepository implements Repository {
      readonly id: string = v4()

      save(): string {
        return 'mysql'
      }
    }

    it('should resolve with undefined dependency when no injection key is specified', async function () {
      class Service {
        constructor(readonly repo: Repository) {}

        act(): string {
          return this.repo.save()
        }
      }

      const di = new DiCaf({ decorators: false })
      di.bind(Service)
        .toSelf()
      await di.init()
      const svc = di.get(Service)
      expect(svc)
        .toBeInstanceOf(Service)
      expect(svc!.repo)
        .toBeUndefined()
    })

    it('should resolve the dependency when it is correctly identified', async function () {
      @Injectable([kRepo])
      class Service {
        constructor(readonly repo: Repository) {}

        act(): string {
          return this.repo.save()
        }
      }

      const di = new DiCaf()
      await di.init()

      for (let i = 0; i < 3; i++) {
        const svc1 = di.get(Service)
        const svc2 = di.get(Service)

        expect(svc1.act())
          .toStrictEqual('mysql')
        expect(svc2.act())
          .toStrictEqual('mysql')
        expect(svc1)
          .toEqual(svc2)
        expect((svc1.repo as MySQLRepository).id)
          .toEqual((svc2.repo as MySQLRepository).id)
      }
    })
  })
})
