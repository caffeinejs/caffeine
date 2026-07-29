import { describe, it, expect } from 'vitest'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Injectable } from '../decorators/injectable.js'
import { Named } from '../decorators/named.js'
import { Primary } from '../decorators/primary.js'
import { Provides } from '../decorators/provides.js'
import { Configuration } from '../decorators/configuration.js'
import { CaffeineIoC } from '../container.js'
import { ErrMultiplePrimary } from '../errors.js'
import { Profile } from '../decorators/profile.js'

describe('@Primary', function () {
  describe('when two @Injectable classes share a named key and both are marked @Primary', function () {
    const kSvc = Symbol('svc-double-primary')

    @Injectable()
    @Named(kSvc)
    @Primary()
    @Profile('double-primary')
    class SvcA {
      name() {
        return 'a'
      }
    }

    @Injectable()
    @Named(kSvc)
    @Primary()
    @Profile('double-primary')
    class SvcB {
      name() {
        return 'b'
      }
    }

    it('should throw ErrMultiplePrimary at setup time', function () {
      expect(() => new CaffeineIoC({ profiles: ['double-primary'] }))
        .toThrow(ErrMultiplePrimary)
    })
  })

  describe('when two @Provides methods share a key and both are marked @Primary', function () {
    const kMsg = Symbol('msg-double-primary')

    class Msg {
      constructor(readonly value: string) {}
    }

    @Configuration()
    @Profile('double-primary')
    class Cfg {
      @Provides(Msg, kMsg)
      @Primary()
      msgA() {
        return new Msg('a')
      }

      @Provides(Msg, kMsg)
      @Primary()
      msgB() {
        return new Msg('b')
      }
    }

    it('should throw ErrMultiplePrimary at setup time', function () {
      expect(() => new CaffeineIoC({ profiles: ['double-primary'] }))
        .toThrow(ErrMultiplePrimary)
    })
  })

  describe('when two @Injectable classes share a named key, both are @Primary, but one is conditionally excluded', function () {
    const kActive = Symbol('svc-conditional-primary')

    @Injectable()
    @Named(kActive)
    @Primary()
    @ConditionalOn(() => false)
    @Profile('conditional-primary')
    class Excluded {
      name() {
        return 'excluded'
      }
    }

    @Injectable()
    @Named(kActive)
    @Primary()
    @Profile('conditional-primary')
    class Active {
      name() {
        return 'active'
      }
    }

    it('should resolve to the surviving primary without error', async function () {
      const di = new CaffeineIoC({ profiles: ['conditional-primary'] })
      await di.init()
      const result = di.get<Active>(kActive)

      expect(result)
        .toBeInstanceOf(Active)
      expect(result.name())
        .toEqual('active')
    })
  })
})
