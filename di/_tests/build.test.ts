import { describe, expect, it } from 'vitest'
import { token } from '../key.js'
import { CaffeineIoC } from '../container.js'
import { ErrInvalidContainerState, ErrMissingInjectionKey, ErrNoResolutionForKey } from '../errors.js'
import { $i } from '../injection.js'
import { Provider } from '../provider.js'
import { Scopes } from '../scope.js'

describe('build()', function () {
  describe('given a zero-arg class', function () {
    it('should build an instance when no injections array is passed', async function () {
      class Service {
        greet() {
          return 'hello'
        }
      }

      const di = new CaffeineIoC({ decorators: false })
      await di.init()

      const svc = di.build(Service)

      expect(svc)
        .toBeInstanceOf(Service)
      expect(svc.greet())
        .toEqual('hello')
    })

    it('should build an instance when an empty injections array is passed', async function () {
      class Service {}

      const di = new CaffeineIoC({ decorators: false })
      await di.init()

      expect(di.build(Service, []))
        .toBeInstanceOf(Service)
    })
  })

  describe('given a class with constructor parameters', function () {
    it('should inject a class-keyed and a string-keyed dependency', async function () {
      class Repo {
        find() {
          return 'row'
        }
      }

      class Usecase {
        constructor(
          readonly repo: Repo,
          readonly env: string,
        ) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(Repo, t => t
        .toSelf())

      di.bind(token<any>('env'), t => t
        .toValue('production'))
      await di.init()

      const uc = di.build(Usecase, [Repo, token<any>('env')])

      expect(uc)
        .toBeInstanceOf(Usecase)
      expect(uc.repo)
        .toBeInstanceOf(Repo)
      expect(uc.repo.find())
        .toEqual('row')
      expect(uc.env)
        .toEqual('production')
    })
  })

  describe('given a plain function (non-constructable)', function () {
    it('should call the function with no deps when no injections are passed', async function () {
      const fn = () => 42

      const di = new CaffeineIoC({ decorators: false })
      await di.init()

      expect(di.build(fn))
        .toEqual(42)
    })

    it('should call the function with resolved deps', async function () {
      class Config {
        readonly host = 'localhost'
      }

      const fn = (config: Config, port: number) => `${config.host}:${port}`

      const di = new CaffeineIoC({ decorators: false })

      di.bind(Config, t => t
        .toSelf())

      di.bind(token<any>('port'), t => t
        .toValue(3000))
      await di.init()

      expect(di.build(fn, [Config, token<any>('port')]))
        .toEqual('localhost:3000')
    })
  })

  describe('with $i.optional()', function () {
    it('should inject the dep when it is registered', async function () {
      class Logger {}

      class Service {
        constructor(readonly logger: Logger | undefined) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(Logger, t => t
        .toSelf())
      await di.init()

      const svc = di.build(Service, [$i.optional(Logger)])

      expect(svc.logger)
        .toBeInstanceOf(Logger)
    })

    it('should inject undefined when the dep is not registered', async function () {
      class Logger {}

      class Service {
        constructor(readonly logger: Logger | undefined) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      await di.init()

      const svc = di.build(Service, [$i.optional(Logger)])

      expect(svc.logger)
        .toBeUndefined()
    })
  })

  describe('with $i.allOf()', function () {
    it('should inject an array of all implementations for an abstract key', async function () {
      abstract class Handler {}
      class HandlerA extends Handler {}
      class HandlerB extends Handler {}

      class Dispatcher {
        constructor(readonly handlers: Handler[]) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(HandlerA, t => t
        .toSelf()
        .extends(Handler))

      di.bind(HandlerB, t => t
        .toSelf()
        .extends(Handler))
      await di.init()

      const dispatcher = di.build(Dispatcher, [$i.allOf(Handler)])

      expect(dispatcher.handlers)
        .toHaveLength(2)
      expect(dispatcher.handlers.some(h => h instanceof HandlerA))
        .toBe(true)
      expect(dispatcher.handlers.some(h => h instanceof HandlerB))
        .toBe(true)
    })

    it('should inject an empty array when no implementations are registered', async function () {
      abstract class Plugin {}

      class Runner {
        constructor(readonly plugins: Plugin[]) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      await di.init()

      const runner = di.build(Runner, [$i.allOf(Plugin)])

      expect(runner.plugins)
        .toEqual([])
    })
  })

  describe('with $i.provide()', function () {
    it('should inject a Provider whose .get() returns the dep', async function () {
      class Connection {}

      class Worker {
        constructor(readonly connProvider: Provider<Connection>) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(Connection, t => t
        .toSelf())
      await di.init()

      const worker = di.build(Worker, [$i.provide(Connection)])

      expect(worker.connProvider.get())
        .toBeInstanceOf(Connection)
    })

    it('should inject a Provider whose .get() returns a new instance each call for transient deps', async function () {
      class Request {}

      class Handler {
        constructor(readonly requestProvider: Provider<Request>) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(Request, t => t
        .toSelf()
        .lifetime(Scopes.TRANSIENT))
      await di.init()

      const handler = di.build(Handler, [$i.provide(Request)])

      const r1 = handler.requestProvider.get()
      const r2 = handler.requestProvider.get()

      expect(r1)
        .toBeInstanceOf(Request)
      expect(r2)
        .toBeInstanceOf(Request)
      expect(r1).not.toBe(r2)
    })

    it('should inject all providers when combined with $i.allOf()', async function () {
      abstract class Validator {}
      class ValidatorA extends Validator {}
      class ValidatorB extends Validator {}

      class Pipeline {
        constructor(readonly validatorsProvider: Provider<Validator[]>) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(ValidatorA, t => t
        .toSelf()
        .extends(Validator))

      di.bind(ValidatorB, t => t
        .toSelf()
        .extends(Validator))
      await di.init()

      const pipeline = di.build(Pipeline, [$i.allOf($i.provide(Validator))])

      const validators = pipeline.validatorsProvider.get()
      expect(validators)
        .toHaveLength(2)
    })
  })
})

describe('when target type is registered in the container', function () {
  it('should build a fresh instance, not return the registered singleton', async function () {
    class Service {}

    const di = new CaffeineIoC({ decorators: false })

    di.bind(Service, t => t
      .toSelf())
    await di.init()

    const singleton = di.get(Service)
    const built = di.build(Service)

    expect(built)
      .toBeInstanceOf(Service)
    expect(built).not.toBe(singleton)
  })

  it('should include the registered binding of the built type when using $i.allOf()', async function () {
    abstract class Handler {}
    class HandlerA extends Handler {}
    class HandlerB extends Handler {}

    class Dispatcher extends Handler {
      constructor(readonly handlers: Handler[]) {
        super()
      }
    }

    const di = new CaffeineIoC({ decorators: false })

    di.bind(HandlerA, t => t
      .toSelf()
      .extends(Handler))

    di.bind(HandlerB, t => t
      .toSelf()
      .extends(Handler))

    di.bind(Dispatcher, t => t
      .toSelf()
      .extends(Handler))
    await di.init()

    const dispatcher = di.build(Dispatcher, [$i.allOf(Handler)])

    expect(dispatcher.handlers)
      .toHaveLength(3)
    expect(dispatcher.handlers.some(h => h instanceof HandlerA))
      .toBe(true)
    expect(dispatcher.handlers.some(h => h instanceof HandlerB))
      .toBe(true)
    expect(dispatcher.handlers.some(h => h instanceof Dispatcher))
      .toBe(true)
  })
})

describe('builder()', function () {
  describe('reuse', function () {
    it('should return a factory that creates a new instance on each call', async function () {
      class Task {
        constructor(readonly name: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(token<any>('name'), t => t
        .toValue('worker'))
      await di.init()

      const factory = di.builder(Task, [token<any>('name')])

      const a = factory()
      const b = factory()

      expect(a)
        .toBeInstanceOf(Task)
      expect(b)
        .toBeInstanceOf(Task)
      expect(a).not.toBe(b)
    })

    it('should capture singleton deps once — all factory calls share the same dep instance', async function () {
      class Config {}

      class Service {
        constructor(readonly config: Config) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(Config, t => t
        .toSelf())
      await di.init()

      const factory = di.builder(Service, [Config])

      const svc1 = factory()
      const svc2 = factory()

      expect(svc1).not.toBe(svc2)
      expect(svc1.config)
        .toBe(svc2.config)
    })

    it('should capture even transient deps eagerly — all factory calls share the same dep instance', async function () {
      class Tracker {}

      class Consumer {
        constructor(readonly tracker: Tracker) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(Tracker, t => t
        .toSelf()
        .lifetime(Scopes.TRANSIENT))
      await di.init()

      const factory = di.builder(Consumer, [Tracker])

      const c1 = factory()
      const c2 = factory()

      expect(c1.tracker)
        .toBe(c2.tracker)
    })

    it('should allow re-resolution on each .get() call when using $i.provide()', async function () {
      class Session {}

      class Controller {
        constructor(readonly sessionProvider: Provider<Session>) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(Session, t => t
        .toSelf()
        .lifetime(Scopes.TRANSIENT))
      await di.init()

      const factory = di.builder(Controller, [$i.provide(Session)])

      const ctrl1 = factory()
      const ctrl2 = factory()

      expect(ctrl1.sessionProvider)
        .toBe(ctrl2.sessionProvider)

      const s1 = ctrl1.sessionProvider.get()
      const s2 = ctrl1.sessionProvider.get()

      expect(s1)
        .toBeInstanceOf(Session)
      expect(s1).not.toBe(s2)
    })
  })

  describe('null and undefined injections', function () {
    it('should pass null to the constructor when the injection is null', async function () {
      class Service {
        constructor(
          readonly a: string,
          readonly b: string | null,
        ) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(token<any>('a'), t => t
        .toValue('hello'))
      await di.init()

      const factory = di.builder(Service, [token<any>('a'), null])
      const instance = factory()

      expect(instance.a)
        .toBe('hello')
      expect(instance.b)
        .toBeNull()
    })

    it('should pass undefined to the constructor when the injection is undefined', async function () {
      class Service {
        constructor(
          readonly a: string,
          readonly b?: string,
        ) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(token<any>('a'), t => t
        .toValue('hello'))
      await di.init()

      const factory = di.builder(Service, [token<any>('a'), undefined])
      const instance = factory()

      expect(instance.a)
        .toBe('hello')
      expect(instance.b)
        .toBeUndefined()
    })

    it('should pass undefined for positions not covered by the injection array', async function () {
      class Service {
        constructor(
          readonly a: string,
          readonly b?: string,
        ) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(token<any>('a'), t => t
        .toValue('hello'))
      await di.init()

      const factory = di.builder(Service, [token<any>('a')])
      const instance = factory()

      expect(instance.a)
        .toBe('hello')
      expect(instance.b)
        .toBeUndefined()
    })

    it('should inject only the specified position — null passes raw null for other positions', async function () {
      class Service {
        constructor(
          readonly first: string | null,
          readonly second: string,
        ) {}
      }

      const di = new CaffeineIoC({ decorators: false })

      di.bind(token<any>('second'), t => t
        .toValue('world'))
      await di.init()

      const factory = di.builder(Service, [null, token<any>('second')])
      const instance = factory()

      expect(instance.first)
        .toBeNull()
      expect(instance.second)
        .toBe('world')
    })
  })

  describe('error cases', function () {
    it('should not validate injection count for non-constructable functions', async function () {
      const fn = (a: string, b: string) => `${a}-${b}`

      const di = new CaffeineIoC({ decorators: false })

      di.bind(token<any>('a'), t => t
        .toValue('x'))
      await di.init()

      expect(() => di.builder(fn, [token<any>('a')])).not.toThrow()
    })

    it('should throw ErrNoResolutionForKey when a required dep is not registered', async function () {
      class Missing {}

      class Consumer {
        constructor(readonly dep: Missing) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      await di.init()

      expect(() => di.build(Consumer, [Missing]))
        .toThrow(ErrNoResolutionForKey)
    })

    it('should throw ErrMissingInjectionKey when an InjectionDescriptor with no key is passed', async function () {
      class Service {
        constructor(readonly dep: unknown) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      await di.init()

      // { optional: true } is a valid InjectionDescriptor but has no key —
      // ctx.key ends up undefined because builder() casts injection.key as Key without guarding
      expect(() => di.builder(Service, [{ optional: true }]))
        .toThrow(ErrMissingInjectionKey)
    })
  })
})

describe('builder() before init()', function () {
  it('should throw ErrInvalidContainerState when called before init()', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(token<any>('svc'), t => t.toValue('hello'))

    expect(() => di.builder(class Svc {}, [])).toThrow(ErrInvalidContainerState)
  })

  it('build() should throw ErrInvalidContainerState when called before init()', function () {
    const di = new CaffeineIoC({ decorators: false })

    expect(() => di.build(class Svc {})).toThrow(ErrInvalidContainerState)
  })
})
