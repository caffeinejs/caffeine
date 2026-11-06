import { describe, expect, it, vi } from 'vitest'

import { $aop, type JoinPoint, type MethodAspect, type Pointcut } from './aop.js'
import { CaffeineIoC } from './container.js'
import { ErrInvalidAspect } from './errors.js'

// An aspect that records each call it advises, by the method's name or by its own `name` when it has one.
function recorder(log: Array<string | symbol>, name?: string): new () => MethodAspect {
  return class implements MethodAspect {
    before(jp: JoinPoint) {
      log.push(name ?? jp.methodName)
    }
  }
}

// Resolves `cls`, or `value` bound under it, in a container whose one aspect records every call it advises, so a test
// reads what was advised from `calls` alone.
async function woven<T extends object>(cls: new () => T, pointcut: Pointcut = $aop.forClass(cls), value?: T) {
  const calls: Array<string | symbol> = []
  const di = new CaffeineIoC({ decorators: false })
  di.bind(cls, t => (value === undefined ? t.toSelf() : t.toValue(value)))
  di.aspect(recorder(calls), t => t.toSelf().pointcuts(pointcut))
  await di.init()
  return { instance: di.get(cls), calls, di }
}

const locks: Array<[string, (instance: object) => void]> = [
  ['an extensible instance', () => undefined],
  ['a frozen instance', instance => Object.freeze(instance)],
  ['a sealed instance', instance => Object.seal(instance)],
]

// An aspect intercepts method calls. Resolving an instance must not run anything else on it, and every member the
// aspect does not advise must behave as it does on an instance the container never touched.
describe('weaving an aspect into an instance', () => {
  describe('accessors', () => {
    // A getter that needs a later lifecycle phase, or throws until first use, would otherwise stop start-up.
    it('never runs a getter while resolving, so one that throws does not stop start-up', async () => {
      class Service {
        get value(): string {
          throw new Error('getter must not run while resolving')
        }

        ping(): string {
          return 'pong'
        }
      }

      const { instance, calls } = await woven(Service)

      expect(instance.ping()).toBe('pong')
      expect(calls).toEqual(['ping'])
    })

    it('runs a getter only when it is read, and returns the live value', async () => {
      let reads = 0
      class Counter {
        state = 1

        get value(): number {
          reads++
          return this.state
        }
      }

      const { instance } = await woven(Counter)
      expect(reads).toBe(0)

      expect(instance.value).toBe(1)
      instance.state = 2
      expect(instance.value).toBe(2)
      expect(reads).toBe(2)
    })

    // A getter/setter pair that holds a callback is an accessor: it must not turn into a plain value at resolve time.
    it('keeps a getter/setter pair an accessor, so an assignment still runs the setter', async () => {
      const assigned: Array<() => string> = []
      class Emitter {
        #listener: () => string = () => 'first'

        get listener(): () => string {
          return this.#listener
        }

        set listener(fn: () => string) {
          assigned.push(fn)
          this.#listener = fn
        }
      }

      const { instance, calls } = await woven(Emitter)
      const second = () => 'second'
      instance.listener = second

      expect(assigned).toEqual([second])
      expect(instance.listener).toBe(second)
      expect(instance.listener()).toBe('second')
      expect(Object.hasOwn(instance, 'listener')).toBe(false)
      expect(calls).toEqual([])
    })

    it('keeps a setter-only accessor working', async () => {
      const levels: string[] = []
      class Logger {
        set level(level: string) {
          levels.push(level)
        }
      }

      const { instance } = await woven(Logger)
      instance.level = 'debug'

      expect(levels).toEqual(['debug'])
      expect(Object.hasOwn(instance, 'level')).toBe(false)
    })

    // A pointcut names methods. A function a getter hands out is not a method of the class, and wrapping it would freeze
    // the value the getter returned at resolve time.
    it('does not advise a function a getter returns, even when a pointcut names the getter', async () => {
      let version = 1
      class Router {
        get handler(): () => number {
          const current = version
          return () => current
        }
      }

      const { instance, calls } = await woven(Router, $aop.forClass(Router, 'handler'))
      version = 2

      expect(instance.handler()).toBe(2)
      expect(calls).toEqual([])
    })

    it('neither weaves nor reads static members', async () => {
      let reads = 0
      class Settings {
        static get defaults(): string {
          reads++
          return 'defaults'
        }

        static load(): string {
          return 'loaded'
        }

        read(): string {
          return 'read'
        }
      }
      const load = Settings.load

      const { calls } = await woven(Settings)

      expect(reads).toBe(0)
      expect(Settings.load).toBe(load)
      expect(Settings.load()).toBe('loaded')
      expect(calls).toEqual([])
    })
  })

  describe('methods', () => {
    it('advises sync, async, generator and async generator methods once per call, returning what each returns', async () => {
      class Kinds {
        sync(): number {
          return 1
        }

        async async(): Promise<number> {
          return 2
        }

        *gen(): Generator<number> {
          yield 3
          yield 4
        }

        async *agen(): AsyncGenerator<number> {
          yield 5
          yield 6
        }
      }

      const { instance, calls } = await woven(Kinds)
      const collected: number[] = []
      for await (const n of instance.agen()) {
        collected.push(n)
      }

      expect(instance.sync()).toBe(1)
      expect(await instance.async()).toBe(2)
      expect([...instance.gen()]).toEqual([3, 4])
      expect(collected).toEqual([5, 6])
      expect(calls).toEqual(['agen', 'sync', 'async', 'gen'])
    })

    // `super.m()` reaches the base method directly, not through the instance, so it is not advised a second time.
    it('advises an override that calls super once', async () => {
      class Base {
        describe(): string {
          return 'base'
        }
      }
      class Child extends Base {
        override describe(): string {
          return `child of ${super.describe()}`
        }
      }

      const { instance, calls } = await woven(Child)

      expect(instance.describe()).toBe('child of base')
      expect(calls).toEqual(['describe'])
    })

    it('advises a method bound in the constructor, also when it is called detached', async () => {
      class Clicker {
        clicks = 0

        constructor() {
          this.click = this.click.bind(this)
        }

        click(): number {
          return ++this.clicks
        }
      }

      const { instance, calls } = await woven(Clicker)
      const detached = instance.click

      expect(detached()).toBe(1)
      expect(instance.clicks).toBe(1)
      expect(calls).toEqual(['click'])
    })

    // A class pointcut covers what the class declares. An arrow function field belongs to each instance, so only a
    // pointcut that names it advises it.
    it('advises an arrow function field only when a pointcut names it', async () => {
      class Handler {
        handle = (): string => 'handled'
      }

      const byClass = await woven(Handler)
      const byName = await woven(Handler, $aop.forClass(Handler, 'handle'))

      expect(byClass.instance.handle()).toBe('handled')
      expect(byClass.calls).toEqual([])
      expect(byName.instance.handle()).toBe('handled')
      expect(byName.calls).toEqual(['handle'])
    })

    // A method that can be neither replaced nor proxied cannot be advised: resolving must say so rather than fail with
    // a raw TypeError or leave the method running without its advice.
    it('refuses an own method that is neither writable nor configurable', async () => {
      class Locked {
        constructor() {
          Object.defineProperty(this, 'ping', { value: () => 'pong', writable: false, configurable: false })
        }
      }

      const error = await woven(Locked, $aop.forClass(Locked, 'ping')).catch((reason: unknown) => reason)

      expect(error).toBeInstanceOf(ErrInvalidAspect)
      expect((error as ErrInvalidAspect).code).toBe('ERR_INVALID_ASPECT')
      expect((error as Error).message.split('\n').slice(0, 5)).toEqual([
        'Cannot weave "Locked.ping": its own "ping" is neither writable nor configurable, so no advice can replace it',
        'Possible Solutions:',
        '  - Declare "ping" only as a method of "Locked", without binding or defining it on each instance',
        '  - Keep the own "ping" writable or configurable: do not freeze the instance, or define it with writable: true',
        '  - Leave "ping" out of the pointcut that matches "Locked"',
      ])
    })

    // Every method is checked before any is replaced: an instance the application holds, such as a bound value, is not
    // left half woven by a refusal.
    it('leaves a refused instance as it was', async () => {
      class Mixed {
        constructor() {
          Object.defineProperty(this, 'locked', { value: () => 'locked', writable: false, configurable: false })
        }

        first(): string {
          return 'first'
        }
      }
      const value = new Mixed()

      const error = await woven(Mixed, $aop.forClass(Mixed, ['first', 'locked']), value).catch(
        (reason: unknown) => reason,
      )

      expect((error as Error).message.split('\n')[0]).toBe(
        'Cannot weave "Mixed.locked": its own "locked" is neither writable nor configurable, so no advice can replace it',
      )
      expect(Object.hasOwn(value, 'first')).toBe(false)
    })

    it.each(locks)(
      'reaches a prototype method patched after resolution on %s, and keeps advising it',
      async (_, lock) => {
        class Plain {
          constructor() {
            lock(this)
          }

          ping(): string {
            return 'original'
          }
        }

        const { instance, calls } = await woven(Plain)
        expect(instance.ping()).toBe('original')
        Plain.prototype.ping = () => 'patched'

        expect(instance.ping()).toBe('patched')
        expect(instance.ping).toBe(instance.ping)
        expect(calls).toEqual(['ping', 'ping'])
      },
    )

    // A test spies on a method after the container resolved its instance; the spy must see the call.
    it.each(locks)('lets a spy on the prototype, set after resolution on %s, see the call', async (_, lock) => {
      class Plain {
        constructor() {
          lock(this)
        }

        ping(): string {
          return 'pong'
        }
      }

      const { instance, calls } = await woven(Plain)
      expect(instance.ping()).toBe('pong')
      const spy = vi.spyOn(Plain.prototype, 'ping')

      expect(instance.ping()).toBe('pong')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(calls).toEqual(['ping', 'ping'])
    })

    it('lets a spy on the instance, set after resolution, see the call while the advice still runs', async () => {
      class Plain {
        ping(): string {
          return 'pong'
        }
      }

      const { instance, calls } = await woven(Plain)
      const spy = vi.spyOn(instance, 'ping')

      expect(instance.ping()).toBe('pong')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(calls).toEqual(['ping'])
    })

    it('leaves a method no pointcut matches as the class declares it', async () => {
      class Pair {
        advised(): string {
          return 'advised'
        }

        other(): string {
          return 'other'
        }
      }

      const { instance } = await woven(Pair, $aop.forClass(Pair, 'advised'))

      expect(instance.other).toBe(Pair.prototype.other)
      expect(Object.hasOwn(instance, 'other')).toBe(false)
    })
  })

  describe('the instance', () => {
    it('proxies a frozen or sealed instance without running its getter', async () => {
      for (const lock of [Object.freeze, Object.seal]) {
        let reads = 0
        class Closed {
          readonly label = 'closed'

          constructor() {
            lock(this)
          }

          get value(): string {
            reads++
            return this.label
          }

          ping(): string {
            return this.label
          }
        }

        const { instance, calls } = await woven(Closed)
        expect(reads).toBe(0)

        expect(instance.ping()).toBe('closed')
        expect(instance.value).toBe('closed')
        expect(reads).toBe(1)
        expect(calls).toEqual(['ping'])
      }
    })

    // Serializing, logging and comparing an instance must not change because an aspect advises it.
    it('lists the same keys and serializes the same as an instance never woven', async () => {
      class Account {
        id = 'acc-1'
        balance = 10

        constructor() {
          this.deposit = this.deposit.bind(this)
        }

        deposit(amount: number): number {
          this.balance += amount
          return this.balance
        }

        describe(): string {
          return this.id
        }
      }

      const { instance } = await woven(Account)
      const plain = new Account()
      const forIn = (o: object) => {
        const keys: string[] = []
        for (const key in o) {
          keys.push(key)
        }
        return keys
      }

      expect(Object.keys(instance)).toEqual(Object.keys(plain))
      expect(forIn(instance)).toEqual(forIn(plain))
      expect(JSON.stringify(instance)).toBe(JSON.stringify(plain))
    })

    it('advises a singleton once per call however often it is resolved', async () => {
      class Single {
        ping(): string {
          return 'pong'
        }
      }

      const { di, calls } = await woven(Single)

      for (let i = 0; i < 3; i++) {
        expect(di.get(Single).ping()).toBe('pong')
      }

      expect(di.get(Single)).toBe(di.get(Single))
      expect(calls).toEqual(['ping', 'ping', 'ping'])
    })

    // Documented on MethodAspect: an instance is woven once, by the first container that resolves it.
    it('runs the aspects of the first container that resolved an instance two containers share', async () => {
      class Shared {
        ping(): string {
          return 'pong'
        }
      }
      const shared = new Shared()
      const log: Array<string | symbol> = []

      const containers = ['first', 'second'].map(name => {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(Shared, t => t.toValue(shared))
        di.aspect(recorder(log, name), t => t.toSelf().pointcuts($aop.forClass(Shared)))
        return di
      })
      for (const di of containers) {
        await di.init()
      }

      expect(containers.map(di => di.get(Shared).ping())).toEqual(['pong', 'pong'])
      expect(log).toEqual(['first', 'first'])
    })
  })
})
