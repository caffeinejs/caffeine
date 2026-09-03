import { describe, expect, it } from 'vitest'
import { CaffeineIoC } from '../container.js'
import { ErrInvalidContainerState } from '../errors.js'
import { $i } from '../injection.js'
import { Scopes } from '../scope.js'

abstract class Validator {
  abstract name(): string
}

class A extends Validator {
  name() {
    return 'a'
  }
}

class B extends Validator {
  name() {
    return 'b'
  }
}

class Singleton { }

class Transient { }

class Absent { }

describe('resolver()', function () {
  async function container() {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(A, t => t.toSelf().extends(Validator))
    di.bind(B, t => t.toSelf().extends(Validator))
    di.bind(Singleton, t => t.toSelf())
    di.bind(Transient, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    await di.init()
    return di
  }

  describe('given a bare token', function () {
    it('should resolve the instance on every call', async function () {
      const di = await container()
      const resolve = di.resolver(Singleton)

      expect(resolve()).toBeInstanceOf(Singleton)
      expect(resolve()).toBe(resolve())
    })
  })

  describe('given an object spec', function () {
    it('should resolve every field, honouring each binding scope', async function () {
      const di = await container()
      const resolve = di.resolver($i.object({
        singleton: Singleton,
        transient: Transient,
        absent: $i.optional(Absent),
        validators: $i.allOf(Validator),
      }))

      const first = resolve()
      const second = resolve()

      expect(first.singleton).toBe(second.singleton)
      expect(first.transient).not.toBe(second.transient)
      expect(first.absent).toBeUndefined()
      expect(first.validators.map(v => v.name()).sort()).toEqual(['a', 'b'])
    })
  })

  describe('given a container that was never initialized', function () {
    it('should fail rather than compile against an empty registry', function () {
      const di = new CaffeineIoC()

      expect(() => di.resolver(Singleton)).toThrow(ErrInvalidContainerState)
    })
  })
})
