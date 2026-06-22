import { describe, it, expect, vi } from 'vitest'
import { v4 } from 'uuid'
import { Provides } from '../decorators/provides.js'
import { Injectable } from '../decorators/injectable.js'
import { Named } from '../decorators/named.js'
import { Primary } from '../decorators/primary.js'
import { DiCaf } from '../container.js'
import { Scopes } from '../scope.js'
import { Lifetime } from '../decorators/lifetime.js'
import { Interceptor } from '../decorators/interceptor.js'
import { ErrInvalidDecorator } from '../errors.js'
import { defer, provide } from '../injection.js'
import { Configuration } from '../decorators/configuration.js'
import { Profile } from '../decorators/profile.js'
import { Provider } from '../provider.js'
import { Foo } from './_testdata/circular_beans/Foo.js'
import { Bar } from './_testdata/circular_beans/Bar.js'

describe('Configuration', function () {
  describe('class factory', function () {
    const spy = vi.fn()

    @Injectable()
    class Repo {
      constructor() {
        spy()
      }

      list() {
        return 'listed'
      }
    }

    @Injectable()
    class Listener {
      constructor() {
        spy()
      }

      listen() {
        return 'listened'
      }
    }

    class Service {
      constructor(
        readonly repo: Repo,
        readonly listener: Listener,
      ) {
        spy()
      }
    }

    @Configuration([Listener])
    class ManyBeans {
      constructor(private readonly listener: Listener) {
        spy()
      }

      @Provides(Service, [Repo])
      service(repo: Repo): Service {
        return new Service(repo, this.listener)
      }
    }

    it('should return instance from method based on class ref', async function () {
      const di = new DiCaf()
      await di.init()
      const service = di.get(Service)

      expect(service)
        .toBeDefined()
      expect(service.repo.list())
        .toEqual('listed')
      expect(service.listener.listen())
        .toEqual('listened')
      expect(spy)
        .toHaveBeenCalledTimes(4)
    })
  })

  describe('named class factory', function () {
    const spy = vi.fn()
    const kTest = Symbol('test')

    class Service {
      readonly id: string = v4()

      constructor(private readonly msg: string) {}

      txt() {
        return this.msg
      }
    }

    @Configuration()
    @Profile('provides-named')
    class Conf {
      @Provides(Service, ['msg'])
      @Named(kTest)
      service(msg: string) {
        spy()
        return new Service(msg)
      }
    }

    it('should resolved named beans', async function () {
      const di = new DiCaf({ profiles: ['provides-named'] })
      const msg = 'hello world'

      di.bind('msg')
        .toValue(msg)
      await di.init()

      const service = di.get<Service>(kTest)
      const service2 = di.get<Service>(kTest)

      expect(service)
        .toBeInstanceOf(Service)
      expect(service.txt())
        .toEqual(msg)
      expect(spy)
        .toHaveBeenCalledTimes(1)
      expect(service)
        .toEqual(service2)
    })
  })

  describe('value factory', function () {
    @Configuration()
    class ValueFactory {
      @Provides('txt')
      txt() {
        return 'hello world'
      }
    }

    @Injectable(['txt'])
    class UsingTxt {
      constructor(readonly txt: string) {}
    }

    it('should inject value provided by bean method', async function () {
      const di = new DiCaf()
      await di.init()
      const txt = di.get('txt')
      const usingTxt = di.get(UsingTxt)
      const expected = 'hello world'

      expect(txt)
        .toEqual(expected)
      expect(usingTxt.txt)
        .toEqual(expected)
    })
  })

  describe('configuration class with primary beans', function () {
    const kInterface = Symbol('interface')

    abstract class Abs {
      abstract test(): string
    }

    @Injectable()
    class Abs1 extends Abs {
      test(): string {
        return 'one'
      }
    }

    interface Interface {
      test(): string
    }

    @Injectable()
    @Named(kInterface)
    class A2 implements Interface {
      test(): string {
        return 'a2'
      }
    }

    @Configuration()
    class Conf {
      @Provides(Abs)
      @Primary()
      abs(): Abs {
        return new class extends Abs {
          test(): string {
            return 'abs-bean'
          }
        }()
      }

      @Provides(kInterface)
      @Primary()
      fromInterface(): Interface {
        return new class implements Interface {
          test(): string {
            return 'interface-bean'
          }
        }()
      }
    }

    it('should use primary beans from configurations class', async function () {
      const di = new DiCaf()
      await di.init()
      const abs = di.get(Abs)
      const i = di.get<Interface>(kInterface)

      expect(abs.test())
        .toEqual('abs-bean')
      expect(i.test())
        .toEqual('interface-bean')
    })
  })

  describe('when beans have dependencies inside same configuration context', function () {
    class Dep {
      readonly id: string = v4()
    }

    class Root {
      constructor(readonly dep: Dep) {}
    }

    @Configuration()
    class Conf {
      @Provides(Dep)
      dep() {
        return new Dep()
      }

      @Provides(Root, [Dep])
      root(dep: Dep) {
        return new Root(dep)
      }
    }

    it('should resolve components referencing another dependencies inside same configuration context', async function () {
      const di = new DiCaf()
      await di.init()
      const root = di.get(Root)
      const dep = di.get(Dep)

      expect(root.dep.id)
        .toEqual(dep.id)
    })
  })

  describe('circular references inside configuration class', function () {
    it('should resolve circular dependencies', async function () {
      @Configuration()
      class CircularConf {
        @Provides(Foo, [provide(defer(() => Bar))])
        foo(bar: Provider<Bar>) {
          return new Foo(bar.get()!)
        }

        @Provides(Bar, [provide(defer(() => Foo))])
        @Lifetime(Scopes.TRANSIENT)
        bar(foo: Provider<Foo>) {
          return new Bar(foo.get()!)
        }
      }

      const di = new DiCaf()
      await di.init()

      const foo = di.get(Foo)
      const bar = di.get(Bar)
      const foo2 = di.get(Foo)
      const bar2 = di.get(Bar)

      di.get(Foo)
      di.get(Bar)

      expect(foo.test())
        .toEqual('foo-bar')
      expect(bar.test())
        .toEqual('bar-foo')

      expect(foo2.test())
        .toEqual('foo-bar')
      expect(bar2.test())
        .toEqual('bar-foo')

      expect(foo.uuid)
        .toEqual(foo2.uuid)
      expect(bar.uuid).not.toEqual(bar2.uuid)
    })
  })

  it('should fail when no key is specified', function () {
    expect(() => {
      class Comp {}

      @Configuration()
      class Conf {
        @Interceptor(instance => instance)
        comp() {
          return new Comp()
        }
      }
    })
      .toThrow(ErrInvalidDecorator)
  })
})
