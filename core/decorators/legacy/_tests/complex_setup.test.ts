import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Injectable } from '../injectable.legacy.js'
import { Named } from '../named.legacy.js'
import { Extends } from '../extends.legacy.js'
import { CaffeineIoC } from '../../../container.js'
import { Primary } from '../primary.legacy.js'
import { Inject } from '../inject.legacy.js'
import { allOf } from '../../../injection.js'

describe('Complex setup', function () {
  describe('given a base abstract class', function () {
    abstract class Repository {
      abstract query(): string
    }

    @Injectable()
    @Named('mysql')
    @Extends()
    @Primary()
    class MySqlRepository extends Repository {
      query() {
        return 'mysql'
      }
    }

    @Injectable()
    @Named('mongo')
    @Extends()
    class MongoRepository extends Repository {
      query() {
        return 'mongo'
      }
    }

    describe('when a service depends on the abstract class', function () {
      @Injectable()
      class Service {
        constructor(readonly repository: Repository) {}
      }

      it('should inject the correct primary injectable', async function () {
        const di = new CaffeineIoC()
        await di.init()

        const service = di.get(Service)

        expect(service.repository)
          .toBeInstanceOf(MySqlRepository)
      })
    })

    describe('when specifying the injection key', function () {
      @Injectable()
      class Service {
        constructor(
          @Inject('mysql') readonly mysql: Repository,
          @Inject('mongo') readonly mongo: Repository,
          @Inject(allOf(Repository)) readonly all: Repository[],
          @Inject(Repository) readonly byType: Repository,
        ) {}
      }

      it('should inject the correct repositories', async function () {
        const di = new CaffeineIoC()
        await di.init()

        const service = di.get(Service)

        expect(service.mysql)
          .toBeInstanceOf(MySqlRepository)
        expect(service.mongo)
          .toBeInstanceOf(MongoRepository)
        expect(service.all)
          .toHaveLength(2)
        expect(service.all.map(r => r.query())
          .sort())
          .toEqual(['mongo', 'mysql'])
        expect(service.byType)
          .toBeInstanceOf(MySqlRepository)
      })
    })
  })
})
