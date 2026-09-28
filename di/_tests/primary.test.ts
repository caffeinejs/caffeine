import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Configuration } from '../decorators/configuration.js'
import { Injectable } from '../decorators/injectable.js'
import { Named } from '../decorators/named.js'
import { Primary } from '../decorators/primary.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'
import { ErrDuplicateBinding, ErrMultiplePrimary } from '../errors.js'
import { token } from '../key.js'

describe('@Primary', function () {
  describe('when two @Injectable classes share a named key and both are marked @Primary', function () {
    const kSvc = token<Record<string, unknown>>(Symbol('svc-double-primary'))

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

    it('should throw ErrMultiplePrimary at setup time', async function () {
      await expect(new CaffeineIoC({ profiles: ['double-primary'] }).compile()).rejects.toThrow(ErrMultiplePrimary)
    })
  })

  describe('when two @Provides methods share a key and both are marked @Primary', function () {
    const kMsg = token<Msg>(Symbol('msg-double-primary'))

    class Msg {
      constructor(readonly value: string) {}
    }

    @Configuration()
    @Profile('double-primary-provides')
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

    // A key takes one binding, so a second one is refused before primaries are ever compared.
    it('should throw ErrDuplicateBinding at setup time', async function () {
      await expect(new CaffeineIoC({ profiles: ['double-primary-provides'] }).compile()).rejects.toThrow(
        ErrDuplicateBinding,
      )
    })
  })

  describe('when two @Injectable classes share a named key, both are @Primary, but one is conditionally excluded', function () {
    const kActive = token<Active>(Symbol('svc-conditional-primary'))

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

      expect(result).toBeInstanceOf(Active)
      expect(result.name()).toEqual('active')
    })
  })
})
