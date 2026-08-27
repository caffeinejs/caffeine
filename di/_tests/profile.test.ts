import { describe, it, beforeAll, expect, vi } from 'vitest'
import { Provides } from '../decorators/provides.js'
import { Injectable } from '../decorators/injectable.js'
import { Profile } from '../decorators/profile.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { CaffeineIoC } from '../container.js'
import { ErrNoResolutionForKey, ErrInvalidContainerState } from '../errors.js'
import { Configuration } from '../decorators/configuration.js'
import { Lazy } from '../decorators/lazy.js'

describe('Profile', function () {
  @Injectable()
  class ProfNone {}

  @Injectable()
  @Profile('prof1')
  class Prof1 {}

  @Injectable()
  @Profile('prof2')
  class Prof2 {}

  @Injectable([Prof1])
  @Profile('prof-cross')
  @Lazy()
  class ProfCrossRef {
    constructor(readonly prof1: Prof1) {}
  }

  @Injectable([Prof2])
  @Profile('prof2')
  class ProfSameRef {
    constructor(readonly prof2: Prof2) {}
  }

  class ProfBean {}

  const kDep = Symbol('dep')
  const kDiffRef = Symbol('diffRef')

  @Configuration()
  @Profile('prof2')
  class Conf {
    @Provides(kDep)
    dep() {
      return 'dep'
    }

    @Provides(ProfBean)
    sameRef() {
      return new ProfBean()
    }
  }

  @Configuration()
  @Profile('prof-cross')
  class ConfCross {
    @Provides(kDiffRef, [Prof1])
    @Lazy()
    diffRef(prof1: Prof1) {
      return prof1
    }
  }

  describe('when profile is set', function () {
    const di = new CaffeineIoC({ profiles: ['prof2'] })

    beforeAll(async () => {
      await di.init()
    })

    it('should return components matching the active profile', function () {
      expect(di.get(Prof2))
        .toBeInstanceOf(Prof2)
      expect(di.get(ProfSameRef))
        .toBeInstanceOf(ProfSameRef)
      expect(di.get(ProfSameRef).prof2)
        .toBeInstanceOf(Prof2)
    })

    it('should include no-profile components (Docker Compose semantics)', function () {
      expect(di.get(ProfNone))
        .toBeInstanceOf(ProfNone)
    })

    it('should throw when requesting a component belonging to a different profile', function () {
      expect(() => di.get(Prof1))
        .toThrow(ErrNoResolutionForKey)
    })
  })

  describe('when no profiles are active', function () {
    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('should only resolve no-profile components and throw for profile-specific ones', function () {
      expect(di.get(ProfNone))
        .toBeInstanceOf(ProfNone)
      expect(() => di.get(Prof1))
        .toThrow(ErrNoResolutionForKey)
      expect(() => di.get(Prof2))
        .toThrow(ErrNoResolutionForKey)
      expect(() => di.get(ProfCrossRef))
        .toThrow(ErrNoResolutionForKey)
    })
  })

  describe('when multiple profiles are active', function () {
    const di = new CaffeineIoC({ profiles: ['prof1', 'prof2', 'prof-cross'] })

    beforeAll(async () => {
      await di.init()
    })

    it('should return components from all active profiles', function () {
      expect(di.get(Prof1))
        .toBeInstanceOf(Prof1)
      expect(di.get(Prof2))
        .toBeInstanceOf(Prof2)
    })

    it('should include no-profile components', function () {
      expect(di.get(ProfNone))
        .toBeInstanceOf(ProfNone)
    })

    it('should resolve cross-profile dependencies when both profiles are active', function () {
      expect(di.get(ProfCrossRef))
        .toBeTruthy()
      expect(di.get(ProfCrossRef).prof1)
        .toBeInstanceOf(Prof1)
    })
  })

  it('should throw at init when a component depends on a component from a different profile', async function () {
    const di = new CaffeineIoC({ profiles: ['prof-cross'] })
    await expect(di.init()).rejects.toThrow(ErrNoResolutionForKey)
  })

  describe('using profiles in configuration providers', function () {
    describe('when profile is set', function () {
      const di = new CaffeineIoC({ profiles: ['prof2'] })

      beforeAll(async () => {
        await di.init()
      })

      it('should return components according to active profile', function () {
        expect(di.get(kDep))
          .toEqual('dep')
        expect(() => di.get(Prof1))
          .toThrow(ErrNoResolutionForKey)
        expect(di.get(ProfBean))
          .toBeInstanceOf(ProfBean)
      })
    })
  })
})

describe('BinderOptions.profiles()', function () {
  it('should keep a manually-bound component when its profile is active', async function () {
    class FluentProfPass {}

    const di = new CaffeineIoC({ decorators: false, profiles: ['fluent-pass'] })
    di.bind(FluentProfPass)
      .toSelf()
      .profiles('fluent-pass')
    await di.init()

    expect(di.has(FluentProfPass)).toBe(true)
    expect(di.get(FluentProfPass)).toBeInstanceOf(FluentProfPass)
  })

  it('should remove a manually-bound component when its profile is inactive', async function () {
    class FluentProfFail {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(FluentProfFail)
      .toSelf()
      .profiles('fluent-fail')
    await di.init()

    expect(di.has(FluentProfFail)).toBe(false)
  })

  it('should register when any listed profile is active', async function () {
    class FluentProfOr {}

    const di = new CaffeineIoC({ decorators: false, profiles: ['fluent-b'] })
    di.bind(FluentProfOr)
      .toSelf()
      .profiles('fluent-a', 'fluent-b')
    await di.init()

    expect(di.has(FluentProfOr)).toBe(true)
  })

  it('should require both profile and conditional to pass', async function () {
    class FluentProfCond {}

    const di = new CaffeineIoC({ decorators: false, profiles: ['fluent-both'] })
    di.bind(FluentProfCond)
      .toSelf()
      .profiles('fluent-both')
      .conditional(() => false)
    await di.init()

    expect(di.has(FluentProfCond)).toBe(false)
  })
})

describe('CaffeineIoC.addProfiles()', function () {
  @Injectable()
  @Profile('add-prof-late')
  class LateProfileBean {}

  it('should pick up decorated types queued during autoWire', async function () {
    const di = new CaffeineIoC()
    expect(di.has(LateProfileBean)).toBe(false)

    di.addProfiles('add-prof-late')
    expect(di.profiles.has('add-prof-late')).toBe(true)

    await di.init()
    expect(di.has(LateProfileBean)).toBe(true)
  })

  it('should union with constructor profiles', async function () {
    @Injectable()
    @Profile('add-prof-ctor')
    class CtorProfileBean {}

    const di = new CaffeineIoC({ profiles: ['add-prof-ctor'] })
    di.addProfiles('add-prof-late')
    await di.init()

    expect(di.has(CtorProfileBean)).toBe(true)
    expect(di.has(LateProfileBean)).toBe(true)
  })

  it('should throw after init', async function () {
    const di = new CaffeineIoC()
    await di.init()
    expect(() => di.addProfiles('too-late')).toThrow(ErrInvalidContainerState)
  })

  it('should throw after compile', async function () {
    const di = new CaffeineIoC()
    await di.compile()
    expect(() => di.addProfiles('too-late')).toThrow(ErrInvalidContainerState)
  })
})

describe('deferred profile evaluation', function () {
  @Injectable()
  @Profile('defer-prof')
  class DeferredProfBean {}

  it('should not register a decorated @Profile type until init', async function () {
    const di = new CaffeineIoC({ profiles: ['defer-prof'] })
    expect(di.has(DeferredProfBean)).toBe(false)
    await di.init()
    expect(di.has(DeferredProfBean)).toBe(true)
  })
})

describe('Profile + ConditionalOn dual queue', function () {
  it('should not run the predicate when the profile misses', async function () {
    const predicate = vi.fn(() => true)

    @Injectable()
    @Profile('dual-miss')
    @ConditionalOn(predicate)
    class DualMissBean {}

    const di = new CaffeineIoC()
    await di.init()

    expect(predicate).not.toHaveBeenCalled()
    expect(di.has(DualMissBean)).toBe(false)
  })

  it('should register when both profile and conditional pass', async function () {
    @Injectable()
    @Profile('dual-hit')
    @ConditionalOn(() => true)
    class DualHitBean {}

    const di = new CaffeineIoC({ profiles: ['dual-hit'] })
    await di.init()

    expect(di.has(DualHitBean)).toBe(true)
  })
})
