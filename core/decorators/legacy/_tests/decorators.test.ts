import 'reflect-metadata'
import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import { CaffeineIoC } from '../../../container.js'
import { Injectable } from '../injectable.legacy.js'
import { Named } from '../named.legacy.js'
import { Primary } from '../primary.legacy.js'
import { Profile } from '../profile.legacy.js'
import { Tag } from '../tag.legacy.js'
import { Label } from '../label.legacy.js'
import { Fallback } from '../fallback.legacy.js'
import { Extends } from '../extends.legacy.js'
import { PostConstruct } from '../post_construct.legacy.js'
import { PreDestroy } from '../pre_destroy.legacy.js'
import { ConditionalOn } from '../conditional_on.legacy.js'

describe('Legacy decorators', function () {
  describe('@Named', function () {
    const KEY = 'legacy-named'

    @Named(KEY)
    @Injectable()
    class NamedSvc {}

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('resolves by name', function () {
      expect(di.get(KEY))
        .toBeInstanceOf(NamedSvc)
    })
  })

  describe('@Primary', function () {
    abstract class Base {
      abstract run(): string
    }

    @Primary()
    @Injectable()
    class PrimaryImpl extends Base {
      run() {
        return 'primary'
      }
    }

    @Injectable()
    class SecondaryImpl extends Base {
      run() {
        return 'secondary'
      }
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('prefers primary when multiple bindings exist', function () {
      const impl = di.get(PrimaryImpl)
      expect(impl.run())
        .toBe('primary')
    })
  })

  describe('@Profile', function () {
    @Profile('prod')
    @Injectable()
    class ProdSvc {
      env() {
        return 'prod'
      }
    }

    @Profile('dev')
    @Injectable()
    class DevSvc {
      env() {
        return 'dev'
      }
    }

    it('only registers matching profile', async function () {
      const di = new CaffeineIoC({ profiles: ['prod'], decorators: false })
      di.autoWire()
      await di.init()

      expect(di.has(ProdSvc))
        .toBe(true)
      expect(di.has(DevSvc))
        .toBe(false)
    })
  })

  describe('@Tag', function () {
    const T = Symbol('tag')

    @Tag(T, 'value')
    @Injectable()
    class TaggedSvc {}

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('binding has tag', function () {
      const binding = di.getBinding(TaggedSvc)
      expect(binding.tags.get(T))
        .toBe('value')
    })
  })

  describe('@Label', function () {
    const L = Symbol('label')

    @Label(L)
    @Injectable()
    class LabeledSvc {}

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('binding has label', function () {
      const results = di.getBindingsByLabel(L)
      expect(results.length)
        .toBeGreaterThan(0)
      expect(results[0].binding.labels)
        .toContain(L)
    })
  })

  describe('@Fallback', function () {
    @Injectable()
    class RealSvc {
      name() {
        return 'real'
      }
    }

    @Fallback()
    @Injectable()
    class FallbackSvc {
      name() {
        return 'fallback'
      }
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('uses real service when available', function () {
      expect(di.get(RealSvc)
        .name())
        .toBe('real')
    })
  })

  describe('@Extends', function () {
    abstract class AbstractRepo {
      abstract find(): string[]
    }

    @Extends(AbstractRepo)
    @Injectable()
    class ConcreteRepo extends AbstractRepo {
      find() {
        return ['a', 'b']
      }
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('resolves by abstract base', function () {
      const repo = di.get(AbstractRepo)
      expect(repo)
        .toBeInstanceOf(ConcreteRepo)
      expect(repo.find())
        .toEqual(['a', 'b'])
    })

    it('auto-detects superclass when no base arg provided', async function () {
      abstract class AutoBase {
        abstract val(): string
      }

      @Extends()
      @Injectable()
      class AutoImpl extends AutoBase {
        val() {
          return 'auto'
        }
      }

      const autoDi = new CaffeineIoC()
      await autoDi.init()
      expect(autoDi.get(AutoBase)).toBeInstanceOf(AutoImpl)
    })

    it('throws when @Extends() applied to class with no superclass', function () {
      expect(() => {
        @Extends()
        @Injectable()
        class NoParent {}
        void NoParent
      }).toThrow()
    })

    it('throws when @Extends(Base) applied to class not extending Base', function () {
      abstract class WrongBase {}
      expect(() => {
        @Extends(WrongBase)
        @Injectable()
        class NotAChild {}
        void NotAChild
      }).toThrow()
    })
  })

  describe('@Injectable error paths', function () {
    it('throws when key is a class reference (not string or symbol)', function () {
      class NotAKey {}
      expect(() => {
        @Injectable(NotAKey as any)
        class BadKey {}
        void BadKey
      }).toThrow()
    })
  })

  describe('@PostConstruct', function () {
    const spy = vi.fn()

    @Injectable()
    class InitSvc {
      initialized = false

      @PostConstruct()
      init() {
        spy()
        this.initialized = true
      }
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('calls post-construct method after creation', function () {
      const svc = di.get(InitSvc)
      expect(svc.initialized)
        .toBe(true)
      expect(spy)
        .toHaveBeenCalled()
    })
  })

  describe('@PreDestroy', function () {
    const spy = vi.fn()

    @Injectable()
    class DestroySvc {
      @PreDestroy()
      cleanup() {
        spy()
      }
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    afterAll(async () => {
      await di.dispose()
    })

    it('calls pre-destroy on dispose', async function () {
      di.get(DestroySvc)
      await di.dispose()
      expect(spy)
        .toHaveBeenCalled()
    })
  })

  describe('@ConditionalOn', function () {
    @ConditionalOn(async ctx => ctx.container.has(Injectable as unknown as symbol))
    @Injectable()
    class ConditionalSvc {}

    @ConditionalOn(() => false)
    @Injectable()
    class ExcludedSvc {}

    it('conditional evaluation runs at init', async function () {
      const di = new CaffeineIoC()
      await di.init()
      expect(di.has(ConditionalSvc))
        .toBeDefined()
    })

    it('excludes bean when predicate returns false', async function () {
      const di = new CaffeineIoC()
      await di.init()
      expect(di.has(ExcludedSvc)).toBe(false)
    })
  })
})
