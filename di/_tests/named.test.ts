import { randomUUID } from 'node:crypto'

import { describe, it, beforeAll, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Configuration } from '../decorators/configuration.js'
import { Injectable } from '../decorators/injectable.js'
import { Named } from '../decorators/named.js'
import { Primary } from '../decorators/primary.js'
import { Provides } from '../decorators/provides.js'
import {
  ErrInvalidContainerState,
  ErrNoResolutionForKey,
  ErrNoUniqueInjectionForKey,
  ErrRepeatedInjectableConfiguration,
} from '../errors.js'
import { token } from '../key.js'

describe('Named Dependencies', function () {
  const kAck = token<AckService>(Symbol('ok'))
  const kBye = token<ByeService>('test-named-dependencies-bye')

  @Injectable()
  @Named(kBye)
  class ByeService {
    readonly id: string = randomUUID()

    bye(): string {
      return 'bye-bye'
    }
  }

  @Injectable([ByeService])
  @Named(kAck)
  class AckService {
    readonly id: string = randomUUID()

    constructor(private readonly byeService: ByeService) {}

    ok(): string {
      return `ok-${this.byeService.bye()}`
    }
  }

  class Msg {
    constructor(readonly type: string) {}
  }

  @Injectable([kBye, kAck])
  class Root {
    readonly id: string = randomUUID()

    constructor(
      readonly byeService: ByeService,
      readonly ackService: AckService,
    ) {}
  }

  it('should resolve based on dependency qualifier', async function () {
    const di = new CaffeineIoC()
    await di.init()
    const root = di.get(Root)

    expect(root.byeService.bye()).toEqual('bye-bye')
    expect(root.ackService.ok()).toEqual('ok-bye-bye')
  })

  it('should resolve same instance when using named and type', async function () {
    const di = new CaffeineIoC()
    await di.init()
    const bye = di.get(ByeService)
    const byeNamed = di.get(kBye)

    expect(bye).toEqual(byeNamed)
  })

  describe('failure scenarios resolving many', function () {
    it('should fail when trying to set multiple raw beans with same name', function () {
      const kTest = token<string>(Symbol('test'))

      expect(() => {
        @Configuration()
        class ManyRawConf {
          @Provides(kTest)
          test1() {
            return 'one'
          }

          @Provides(kTest)
          test2() {
            return 'two'
          }
        }

        new CaffeineIoC()
      }).toThrow()
    })

    it('should fail when repeating the same bean key', function () {
      const kOne = token<Record<string, unknown>>(Symbol('one'))

      expect(() => {
        @Configuration()
        class Rep {
          @Provides(Msg)
          msg1() {
            return new Msg('one_1')
          }

          @Provides(Msg)
          msg1_1() {
            return new Msg('one_1_1')
          }
        }

        new CaffeineIoC()
      }).toThrow()
    })
  })

  describe('when configuration provides many components of same type with different names', function () {
    const kTwo = token<Msg>(Symbol('two'))
    const kAm = token<Msg>(Symbol('am'))
    const kEu = token<Msg>(Symbol('eu'))

    @Configuration()
    class Conf {
      @Provides(Msg, kTwo)
      msg2() {
        return new Msg('two_2')
      }

      @Provides(Msg, kAm)
      msg3() {
        return new Msg('am')
      }

      @Provides(Msg, kEu)
      @Primary()
      msg3_1() {
        return new Msg('eu')
      }
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    describe('and requesting many instances of a type', function () {
      it('should return an array with a single entry when passing a named key with one entry', function () {
        const twos = di.getMany<Msg>(kTwo)

        expect(twos).toHaveLength(1)
        expect(twos[0]).toBeInstanceOf(Msg)
        expect(twos[0].type).toEqual('two_2')
      })
    })

    it('should throw when requesting a instance with the unregistered class type', function () {
      expect(() => di.get(Msg)).toThrow(ErrNoResolutionForKey)
    })

    it('should return an specific instance for each named provided bean', function () {
      const two = di.get<Msg>(kTwo)
      const am = di.get<Msg>(kAm)
      const eu = di.get<Msg>(kEu)

      expect(two.type).toEqual('two_2')
      expect(am.type).toEqual('am')
      expect(eu.type).toEqual('eu')
    })
  })

  describe('getManyOptional', function () {
    class LocalSvc {}

    describe('when no binding exists for the key', function () {
      it('should return empty array for unregistered class key', async function () {
        const di = new CaffeineIoC({ decorators: false })
        await di.init()

        expect(di.getManyOptional(LocalSvc)).toEqual([])
      })

      it('should return empty array for unregistered symbol key', async function () {
        const kMissing = token<Record<string, unknown>>(Symbol('missing'))
        const di = new CaffeineIoC({ decorators: false })
        await di.init()

        expect(di.getManyOptional(kMissing)).toEqual([])
      })

      it('should return empty array for unregistered string key', async function () {
        const di = new CaffeineIoC({ decorators: false })
        await di.init()

        expect(di.getManyOptional(token<Record<string, unknown>>('no-such-key'))).toEqual([])
      })
    })

    describe('when a single binding exists', function () {
      it('should return array with one instance for class key', async function () {
        const di = new CaffeineIoC({ decorators: false })
        di.addModules(c => {
          c.bind(LocalSvc, t => t.toSelf())
        })
        await di.init()

        const result = di.getManyOptional(LocalSvc)
        expect(result).toHaveLength(1)
        expect(result[0]).toBeInstanceOf(LocalSvc)
      })

      it('should return array with one instance for symbol key', async function () {
        const kSymbol = token<number>(Symbol('getManyOptional-single'))
        const di = new CaffeineIoC({ decorators: false })
        di.addModules(c => {
          c.bind(kSymbol, t => t.toValue(42))
        })
        await di.init()

        const result = di.getManyOptional(kSymbol)
        expect(result).toHaveLength(1)
        expect(result[0]).toBe(42)
      })

      it('should return array with one instance for string key', async function () {
        const di = new CaffeineIoC({ decorators: false })
        di.addModules(c => {
          c.bind(token<string>('str-key'), t => t.toValue('hello'))
        })
        await di.init()

        const result = di.getManyOptional(token<Record<string, unknown>>('str-key'))
        expect(result).toHaveLength(1)
        expect(result[0]).toBe('hello')
      })
    })

    describe('contrast with getMany', function () {
      it('should return empty array where getMany would throw', async function () {
        const kUnknown = token<Record<string, unknown>>(Symbol('unknown'))
        const di = new CaffeineIoC({ decorators: false })
        await di.init()

        expect(() => di.getMany(kUnknown)).toThrow(ErrNoResolutionForKey)
        expect(di.getManyOptional(kUnknown)).toEqual([])
      })
    })

    it('should throw ErrInvalidContainerState before init', function () {
      const di = new CaffeineIoC({ decorators: false })

      expect(() => di.getManyOptional(LocalSvc)).toThrow(ErrInvalidContainerState)
    })
  })

  describe('attempting to use same name multiple times', function () {
    it('should fail to register the component', function () {
      const kTest = token<Record<string, unknown>>(Symbol('test'))

      expect(() => {
        @Injectable()
        @Named(kTest)
        @Named(kTest)
        class Dep {}
      }).toThrow(ErrRepeatedInjectableConfiguration)
    })
  })
})

describe('has() and a named binding', function () {
  it('reports a name the binding was registered under as present', async function () {
    const kAlias = token<NamedSvc>(Symbol('has-named-alias'))
    const kUnused = token<Record<string, unknown>>(Symbol('has-named-unused'))

    class NamedSvc {
      tag(): string {
        return 'named'
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(NamedSvc, t => t.toSelf().names(kAlias))
    await di.init()

    // The same index `get` resolves from, so the two cannot disagree.
    expect(di.has(kAlias)).toBe(true)
    expect(di.get(kAlias).tag()).toBe('named')
    expect(di.has(kUnused)).toBe(false)
  })
})

// A key bound directly and a binding named after it both answer to the key, whichever was registered first.
describe('a key bound directly next to a binding named after it', function () {
  interface Mailer {
    via(): string
  }

  const kMailer = token<Mailer>(Symbol('named-direct-mailer'))

  class SmtpMailer implements Mailer {
    via(): string {
      return 'smtp'
    }
  }

  class SesMailer implements Mailer {
    via(): string {
      return 'ses'
    }
  }

  for (const directFirst of [false, true]) {
    it(`keeps both as candidates, ${directFirst ? 'direct binding first' : 'named binding first'}`, async function () {
      const di = new CaffeineIoC({ decorators: false })
      const named = () => di.bind(SmtpMailer, t => t.toSelf().names(kMailer))
      const direct = () => di.bind(kMailer, t => t.toClass(SesMailer))

      if (directFirst) {
        direct()
        named()
      } else {
        named()
        direct()
      }

      await di.init()

      expect(
        di
          .getMany(kMailer)
          .map(m => m.via())
          .sort(),
      ).toEqual(['ses', 'smtp'])
      expect(() => di.get(kMailer)).toThrow(ErrNoUniqueInjectionForKey)
    })
  }
})
