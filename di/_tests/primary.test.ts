import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Conditional } from '../decorators/conditional.js'
import { Configuration } from '../decorators/configuration.js'
import { Injectable } from '../decorators/injectable.js'
import { Named } from '../decorators/named.js'
import { Primary } from '../decorators/primary.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'
import { ErrMultiplePrimary } from '../errors.js'
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

    // A profile is a condition, so both are held until the container compiles, and decided there.
    it('should throw ErrMultiplePrimary when the container compiles', async function () {
      await expect(new CaffeineIoC({ profiles: ['double-primary'] }).init()).rejects.toThrow(ErrMultiplePrimary)
    })
  })

  // Two keys answering to one name: a single key provided twice would be a repeated binding instead.
  describe('when two @Provides methods answer to one name and both are marked @Primary', function () {
    const kMsg = token<Msg>(Symbol('msg-double-primary'))
    const kMsgA = token<Msg>(Symbol('msg-double-primary-a'))
    const kMsgB = token<Msg>(Symbol('msg-double-primary-b'))

    class Msg {
      constructor(readonly value: string) {}
    }

    @Configuration()
    @Profile('double-primary-provides')
    class Cfg {
      @Provides(kMsgA)
      @Named(kMsg)
      @Primary()
      msgA() {
        return new Msg('a')
      }

      @Provides(kMsgB)
      @Named(kMsg)
      @Primary()
      msgB() {
        return new Msg('b')
      }
    }

    it('should throw ErrMultiplePrimary when the container compiles', async function () {
      await expect(new CaffeineIoC({ profiles: ['double-primary-provides'] }).init()).rejects.toThrow(
        ErrMultiplePrimary,
      )
    })
  })

  describe('when two @Injectable classes share a named key, both are @Primary, but one is conditionally excluded', function () {
    const kActive = token<Active>(Symbol('svc-conditional-primary'))

    @Injectable()
    @Named(kActive)
    @Primary()
    @Conditional(c => c.when(() => false))
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
