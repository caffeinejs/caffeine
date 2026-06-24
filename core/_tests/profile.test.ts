import { describe, it, beforeAll, expect } from 'vitest'
import { Provides } from '../decorators/provides.js'
import { Injectable } from '../decorators/injectable.js'
import { Profile } from '../decorators/profile.js'
import { CaffeineIoC } from '../container.js'
import { ErrNoResolutionForKey } from '../errors.js'
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
