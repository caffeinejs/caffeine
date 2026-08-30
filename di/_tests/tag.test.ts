import { describe, it, expect } from 'vitest'
import { token } from '../key.js'
import { Provides } from '../decorators/provides.js'
import { Configuration } from '../decorators/configuration.js'
import { Injectable } from '../decorators/injectable.js'
import { Tag } from '../decorators/tag.js'
import { CaffeineIoC } from '../container.js'

describe('Tag', function () {
  it('should attach and retrieve a tag from a class binding', function () {
    const kRoute = token<any>(Symbol('route'))

    @Tag(kRoute, '/users')
    @Injectable()
    class UserCtrl {}

    const di = new CaffeineIoC()
    const binding = di.getBindings(UserCtrl)[0]

    expect(binding.tags.get(kRoute))
      .toBe('/users')
  })

  it('should return undefined for a tag key never set on a binding', function () {
    const kRoute = token<any>(Symbol('route'))

    @Injectable()
    class Plain {}

    const di = new CaffeineIoC()
    const binding = di.getBindings(Plain)[0]

    expect(binding.tags.get(kRoute))
      .toBeUndefined()
  })

  it('should keep two distinct tag keys independent of each other', function () {
    const kA = token<any>(Symbol('a'))
    const kB = token<any>(Symbol('b'))

    @Tag(kB, 42)
    @Tag(kA, 'hello')
    @Injectable()
    class Both {}

    const di = new CaffeineIoC()
    const binding = di.getBindings(Both)[0]

    expect(binding.tags.get(kA))
      .toBe('hello')
    expect(binding.tags.get(kB))
      .toBe(42)
  })

  it('last write wins when Tag is stacked twice with the same key', function () {
    const kSlot = token<any>(Symbol('slot'))

    @Tag(kSlot, 'second')
    @Tag(kSlot, 'first')
    @Injectable()
    class Overwritten {}

    const di = new CaffeineIoC()
    const binding = di.getBindings(Overwritten)[0]

    expect(binding.tags.get(kSlot))
      .toBe('second')
  })

  describe('array accumulation', function () {
    it('should concatenate arrays when Tag is stacked with the same key on a class', function () {
      const k = token<any>(Symbol('arr'))

      @Tag(k, [1, 2])
      @Tag(k, [3])
      @Injectable()
      class Accumulated {}

      const di = new CaffeineIoC()
      const binding = di.getBindings(Accumulated)[0]

      expect(binding.tags.get(k))
        .toEqual([1, 2, 3])
    })

    it('should concatenate arrays when Tag is stacked on a @Provides method', function () {
      const k = token<any>(Symbol('arr'))
      const kBean = token<any>(Symbol('arrBean'))

      @Configuration()
      class Conf {
        @Provides(kBean)
        @Tag(k, [1, 2])
        @Tag(k, [3])
        bean() {
          return {}
        }
      }
      void Conf

      const di = new CaffeineIoC()
      const binding = di.getBindings(kBean)[0]

      expect(binding.tags.get(k))
        .toEqual([1, 2, 3])
    })

    it('primitive last-write-wins is unchanged when type does not match existing array', function () {
      const k = token<any>(Symbol('mismatch'))

      @Tag(k, 'scalar')
      @Tag(k, [1, 2])
      @Injectable()
      class Mismatch {}

      const di = new CaffeineIoC()
      const binding = di.getBindings(Mismatch)[0]

      expect(binding.tags.get(k))
        .toBe('scalar')
    })
  })

  describe('set accumulation', function () {
    it('should union Sets when Tag is stacked with the same key', function () {
      const k = token<any>(Symbol('set'))

      @Tag(k, new Set([1, 2]))
      @Tag(k, new Set([2, 3]))
      @Injectable()
      class MergedSet {}

      const di = new CaffeineIoC()
      const result = di.getBindings(MergedSet)[0].tags.get(k) as Set<number>

      expect(result)
        .toEqual(new Set([1, 2, 3]))
    })
  })

  describe('map accumulation', function () {
    it('should merge Map entries when Tag is stacked with the same key', function () {
      const k = token<any>(Symbol('map'))

      @Tag(k, new Map([['a', 1]]))
      @Tag(k, new Map([['b', 2]]))
      @Injectable()
      class MergedMap {}

      const di = new CaffeineIoC()
      const result = di.getBindings(MergedMap)[0].tags.get(k) as Map<string, number>

      expect(result.get(token<any>('a')))
        .toBe(1)
      expect(result.get(token<any>('b')))
        .toBe(2)
    })

    it('outer decorator wins for conflicting Map keys', function () {
      const k = token<any>(Symbol('mapConflict'))

      @Tag(k, new Map([['x', 'outer']]))
      @Tag(k, new Map([['x', 'inner']]))
      @Injectable()
      class MapConflict {}

      const di = new CaffeineIoC()
      const result = di.getBindings(MapConflict)[0].tags.get(k) as Map<string, string>

      expect(result.get(token<any>('x')))
        .toBe('outer')
    })
  })

  describe('plain object accumulation', function () {
    it('should shallow-merge plain objects when Tag is stacked with the same key', function () {
      const k = token<any>(Symbol('obj'))

      @Tag(k, { a: 1 })
      @Tag(k, { b: 2 })
      @Injectable()
      class MergedObj {}

      const di = new CaffeineIoC()
      const result = di.getBindings(MergedObj)[0].tags.get(k) as Record<string, number>

      expect(result.a)
        .toBe(1)
      expect(result.b)
        .toBe(2)
    })

    it('outer decorator wins for conflicting object keys', function () {
      const k = token<any>(Symbol('objConflict'))

      @Tag(k, { x: 'outer' })
      @Tag(k, { x: 'inner' })
      @Injectable()
      class ObjConflict {}

      const di = new CaffeineIoC()
      const result = di.getBindings(ObjConflict)[0].tags.get(k) as Record<string, string>

      expect(result.x)
        .toBe('outer')
    })
  })

  describe('on @Provides methods inside @Configuration', function () {
    it('should attach and retrieve a tag from a bean binding', function () {
      const kPath = token<any>(Symbol('path'))
      const kEndpoint = token<any>(Symbol('endpoint'))

      @Configuration()
      class APIConf {
        @Provides(kEndpoint)
        @Tag(kPath, '/api/v1')
        endpoint() {
          return { url: '/api/v1' }
        }
      }
      void APIConf

      const di = new CaffeineIoC()
      const descriptors = di.getBindings(kEndpoint)

      expect(descriptors)
        .toHaveLength(1)
      expect(descriptors[0].tags.get(kPath))
        .toBe('/api/v1')
    })

    it('last write wins when Tag is stacked on a @Provides method', function () {
      const kSlot = token<any>(Symbol('slot'))
      const kBean = token<any>(Symbol('bean'))

      @Configuration()
      class Conf {
        @Provides(kBean)
        @Tag(kSlot, 'second')
        @Tag(kSlot, 'first')
        bean() {
          return {}
        }
      }
      void Conf

      const di = new CaffeineIoC()
      const descriptors = di.getBindings(kBean)

      expect(descriptors[0].tags.get(kSlot))
        .toBe('second')
    })
  })
})
