import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Lifetime } from '../decorators/lifetime.js'
import { Named } from '../decorators/named.js'
import { Provides } from '../decorators/provides.js'
import { ErrInvalidDecorator, ErrOrphanedBindingConfig } from '../errors.js'
import { token } from '../key.js'
import { Scopes } from '../scope.js'

describe('Orphaned binding config validation', function () {
  it('should throw when @Lifetime is used without @Injectable', function () {
    @Lifetime(Scopes.SINGLETON)
    class Svc {}
    void Svc

    expect(() => new CaffeineIoC()).toThrow(ErrOrphanedBindingConfig)
  })

  it('should throw when @Named is used without @Injectable', function () {
    @Named('svc')
    class Svc {}
    void Svc

    expect(() => new CaffeineIoC()).toThrow(ErrOrphanedBindingConfig)
  })

  it('should throw when @Provides is used at class level', function () {
    const kSvc = token<Record<string, unknown>>(Symbol('svc'))

    expect(() => {
      // @ts-expect-error intentional: testing runtime guard for class-level misuse
      @Provides(kSvc)
      class Svc {}
      void Svc
    }).toThrow(ErrInvalidDecorator)
  })
})
