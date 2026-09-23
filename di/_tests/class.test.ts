import { randomUUID } from 'node:crypto'

import { describe, it, beforeAll, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Injectable } from '../decorators/injectable.js'
import { Named } from '../decorators/named.js'
import { Primary } from '../decorators/primary.js'
import { ErrInvalidDecorator, ErrNoUniqueInjectionForKey, ErrNoResolutionForKey } from '../errors.js'
import { $i } from '../injection.js'
import { token } from '../key.js'

describe('Class', function () {
  describe('when using dependencies with default configurations', function () {
    let constructed = 0
    function constructedOnce() {
      constructed += 1
    }

    @Injectable()
    class SeeYaService {
      readonly id: string = randomUUID()

      constructor() {
        constructedOnce()
      }

      bye(): string {
        return 'bye-bye'
      }
    }

    @Injectable([SeeYaService])
    class OkService {
      readonly id: string = randomUUID()

      constructor(private readonly seeYaService: SeeYaService) {
        constructedOnce()
      }

      ok(): string {
        return `ok-${this.seeYaService.bye()}`
      }
    }

    @Injectable([SeeYaService, OkService])
    class Root {
      readonly id: string = randomUUID()

      constructor(
        readonly seeYaService: SeeYaService,
        readonly okService: OkService,
      ) {
        constructedOnce()
      }
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('should register class and resolve it when requested', function () {
      const root = di.get(Root)

      expect(root).toBeDefined()
      expect(new CaffeineIoC().has(Root)).toBeTruthy()
      expect(root.seeYaService.bye()).toEqual('bye-bye')
      expect(root.okService.ok()).toEqual('ok-bye-bye')
      expect(constructed).toBe(3) // there are 3 dependencies: SeeYaService, OkService, Root
    })

    it('should return singleton instance as default', function () {
      const root1 = di.get(Root)
      const root2 = di.get(Root)

      expect(root1).toEqual(root2)
      expect(root1.id).toEqual(root2.id)
      expect(constructed).toBe(3) // there are 3 dependencies: SeeYaService, OkService, Root
    })
  })

  describe('when trying to initialize with unregistered dependencies', function () {
    class Repo {
      name(): string {
        return 'repo'
      }
    }

    class Service {
      constructor(private readonly repo: Repo) {}
    }

    it('should throw error', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(Service, t => t.toSelf([Repo]))

      await expect(di.init()).rejects.toThrow(ErrNoResolutionForKey)
    })
  })

  describe('when injecting multiple dependencies with the same key', function () {
    const kIdentifier = token<Base>(Symbol('testID'))

    abstract class Base {
      abstract hello(): string
    }

    @Injectable()
    @Named(kIdentifier)
    class En extends Base {
      hello(): string {
        return 'hi'
      }
    }

    @Injectable()
    @Named(kIdentifier)
    class Pt extends Base {
      hello(): string {
        return 'oi'
      }
    }

    @Injectable([$i.allOf(kIdentifier)])
    class Lang {
      constructor(readonly all: Base[]) {}
    }

    it('should resolve class dependency array with all named with the same value', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const lang = di.get(Lang)

      expect(lang.all).toHaveLength(2)
      expect(lang.all[0].hello()).toEqual('hi')
      expect(lang.all[1].hello()).toEqual('oi')
    })
  })

  describe('resolving multiple for same Key', function () {
    describe('when multiple resolutions exists for a named Key', function () {
      const kName = token<{ name(): string }>(Symbol('svc'))

      @Injectable()
      @Named(kName)
      class Svc1 {
        name() {
          return 'svc1'
        }
      }

      @Injectable()
      @Named(kName)
      @Primary()
      class Svc2 {
        name() {
          return 'svc2'
        }
      }

      it('should resolve the one defined as primary when only one resolution is requested', async function () {
        const di = new CaffeineIoC()
        await di.init()
        const dep = di.get<Svc2>(kName)

        expect(dep.name()).toEqual('svc2')
      })
    })

    describe('when multiple injectables are named equally but none is defined as primary', function () {
      const name = token<Record<string, unknown>>('svc-no-single')

      @Injectable()
      @Named(name)
      class Svc1 {}

      @Injectable()
      @Named(name)
      class Svc2 {}

      it('should throw error when requesting a single instance', async function () {
        const di = new CaffeineIoC()
        await di.init()

        expect(() => di.get(name)).toThrow(ErrNoUniqueInjectionForKey)
      })

      it('should return an array of instances when requesting many instances - regardless of the primary definition', async function () {
        const di = new CaffeineIoC()
        await di.init()

        expect(di.getMany(name)).toHaveLength(2)
      })
    })

    describe('when resolving multiple of non existent', function () {
      it('should throw when no bindings registered', async function () {
        const di = new CaffeineIoC()
        await di.init()

        expect(() => di.getMany(token<Record<string, unknown>>('nonexistent'))).toThrow(ErrNoResolutionForKey)
      })
    })
  })

  describe('nested resolution graph', function () {
    describe('and using singleton scope for all', function () {
      @Injectable()
      class Dep {
        readonly id: string = randomUUID()
      }

      @Injectable([Dep])
      class Repo {
        readonly id: string = randomUUID()

        constructor(readonly dep: Dep) {}
      }

      @Injectable([Repo, Dep])
      class Service {
        readonly id: string = randomUUID()

        constructor(
          readonly repo: Repo,
          readonly dep: Dep,
        ) {}
      }

      @Injectable([Dep, Service, Repo])
      class Controller {
        readonly id: string = randomUUID()

        constructor(
          readonly dep: Dep,
          readonly service: Service,
          readonly repo: Repo,
        ) {}
      }

      it('should resolve with same instance from previous resolutions', async function () {
        const di = new CaffeineIoC()
        await di.init()

        const controller = di.get(Controller)
        const service = di.get(Service)
        const repo = di.get(Repo)
        const dep = di.get(Dep)

        expect(controller.dep).toEqual(dep)
        expect(controller.repo).toEqual(repo)
        expect(controller.service).toEqual(service)
        expect(service.dep).toEqual(dep)
        expect(service.repo).toEqual(repo)
        expect(repo.dep).toEqual(dep)
      })
    })
  })

  describe('non property constructor resolution', function () {
    @Injectable()
    class Dep {
      id = 'hello world'
    }

    @Injectable([Dep])
    class Root {
      readonly dep: Dep

      constructor(private _dep: Dep) {
        this.dep = _dep
      }
    }

    it('should injection values on non exposed constructor arguments', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const root = di.get(Root)

      expect(root).toBeInstanceOf(Root)
      expect(root.dep).toBeInstanceOf(Dep)
      expect(root.dep.id).toEqual('hello world')
    })
  })

  describe('$i.just() injection', function () {
    @Injectable([$i.just('injected-constant')])
    class SingleValueDep {
      constructor(readonly label: string) {}
    }

    @Injectable([$i.just('host'), $i.just(8080)])
    class MultiValueDep {
      constructor(
        readonly host: string,
        readonly port: number,
      ) {}
    }

    @Injectable()
    class BareDep {
      tag = 'bare'
    }

    @Injectable([BareDep, $i.just('mixed')])
    class MixedDep {
      constructor(
        readonly dep: BareDep,
        readonly label: string,
      ) {}
    }

    it('should inject a constant string via @Injectable', async function () {
      const di = new CaffeineIoC()
      await di.init()

      expect(di.get(SingleValueDep).label).toEqual('injected-constant')
    })

    it('should inject multiple constants via @Injectable', async function () {
      const di = new CaffeineIoC()
      await di.init()

      expect(di.get(MultiValueDep).host).toEqual('host')
      expect(di.get(MultiValueDep).port).toEqual(8080)
    })

    it('should mix container-resolved and constant injections', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const mixed = di.get(MixedDep)
      expect(mixed.dep).toBeInstanceOf(BareDep)
      expect(mixed.label).toEqual('mixed')
    })
  })

  describe('@Injectable — rejects class references as qualifier keys', function () {
    abstract class Base {}

    it('should throw with a helpful message when a class is passed as key', function () {
      expect(() => {
        @Injectable(Base as any)
        class Impl extends Base {}
        void Impl
      }).toThrow(ErrInvalidDecorator)
    })
  })

  describe('when using a custom key', function () {
    const kKey = token<Service>(Symbol('key'))

    @Injectable(kKey)
    class Service {
      readonly kind = 'service'

      constructor() {}
    }

    it('should resolve the class with the custom key and the class ctor', async function () {
      const di = new CaffeineIoC()
      await di.init()

      expect(di.get(kKey)).toBeInstanceOf(Service)
      expect(di.get(Service)).toBeInstanceOf(Service)
    })
  })
})
