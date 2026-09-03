import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Configuration } from '../decorators/configuration.js'
import { Injectable } from '../decorators/injectable.js'
import { Label } from '../decorators/label.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'
import { token } from '../key.js'

describe('Label', function () {
  it('should tag a class and return its binding via getBy', function () {
    const sym = token<any>(Symbol('svc'))

    @Label(sym)
    @Injectable()
    class Svc {}

    const di = new CaffeineIoC()

    const result = di.getBindingsBy(descriptor => descriptor.binding.labels.includes(sym))
    expect(result).toHaveLength(1)
    expect(result[0].key).toBe(Svc)
  })

  it('should support multiple labels on a single class', function () {
    const sym1 = token<any>(Symbol('a'))
    const sym2 = token<any>(Symbol('b'))

    @Label(sym1, sym2)
    @Injectable()
    class Multi {}

    const di = new CaffeineIoC()

    expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(sym1))).toHaveLength(1)
    expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(sym2))).toHaveLength(1)
  })

  it('should accumulate labels when @Label is stacked', function () {
    const sym1 = token<any>(Symbol('x'))
    const sym2 = token<any>(Symbol('y'))

    @Label(sym2)
    @Label(sym1)
    @Injectable()
    class Stacked {}

    const di = new CaffeineIoC()

    expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(sym1))).toHaveLength(1)
    expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(sym2))).toHaveLength(1)
    expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(sym1))[0].key).toBe(Stacked)
  })

  it('should return a BindingDescriptor with the correct key and labels', function () {
    const sym = token<any>(Symbol('resolve'))

    @Label(sym)
    @Injectable()
    class Resolved {}

    const di = new CaffeineIoC()
    const descriptors = di.getBindingsByLabel(sym)

    expect(descriptors).toHaveLength(1)
    expect(descriptors[0].key).toBe(Resolved)
    expect(descriptors[0].binding.labels).toContain(sym)
  })

  it('should return BindingDescriptor[] from getBindingsBy, not resolved instances', function () {
    const sym = token<any>(Symbol('bindings-only'))

    @Label(sym)
    @Injectable()
    class Target {}

    const di = new CaffeineIoC()
    const result = di.getBindingsBy(descriptor => descriptor.binding.labels.includes(sym))

    expect(result[0]).not.toBeInstanceOf(Target)
    expect(typeof result[0].key).toBe('function')
  })

  it('should not return the binding of a class that fails its conditional', function () {
    const sym = token<any>(Symbol('cond'))

    @Label(sym)
    @ConditionalOn(() => false)
    @Injectable()
    class Excluded {}

    const di = new CaffeineIoC()

    expect(di.has(Excluded)).toBe(false)
    expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(sym))).toHaveLength(0)
  })

  it('should respect profile when querying labels via child container', async function () {
    const sym = token<any>(Symbol('ns-label'))

    @Label(sym)
    @Profile('myns')
    @Injectable()
    class NsService {}

    const root = new CaffeineIoC()
    const child = new CaffeineIoC({ profiles: ['myns'] })
    await root.init()
    await child.init()

    expect(root.getBindingsBy(descriptor => descriptor.binding.labels.includes(sym))).toHaveLength(0)
    expect(child.getBindingsBy(descriptor => descriptor.binding.labels.includes(sym))).toHaveLength(1)
  })

  describe('on @Provides methods inside @Configuration', function () {
    it('should tag a bean method and return its binding via getBindingsByLabel', function () {
      const sym = token<any>(Symbol('bean-label'))
      const kSvc = token<any>(Symbol('svc-key'))

      @Configuration()
      class Conf {
        @Provides(kSvc)
        @Label(sym)
        svc() {
          return 'value'
        }
      }

      const di = new CaffeineIoC()

      const result = di.getBindingsBy(descriptor => descriptor.binding.labels.includes(sym))
      expect(result).toHaveLength(1)
      expect(result[0].binding.labels).toContain(sym)
    })

    it('should return a BindingDescriptor with the correct key and labels when label is on @Provides method', function () {
      const sym = token<any>(Symbol('bean-label-resolve'))
      const kItem = token<any>(Symbol('item-key'))

      @Configuration()
      class ItemConf {
        @Provides(kItem)
        @Label(sym)
        item() {
          return { name: 'item' }
        }
      }

      const di = new CaffeineIoC()
      const descriptors = di.getBindingsByLabel(sym)

      expect(descriptors).toHaveLength(1)
      expect(descriptors[0].key).toBe(kItem)
      expect(descriptors[0].binding.labels).toContain(sym)
    })
  })
})
