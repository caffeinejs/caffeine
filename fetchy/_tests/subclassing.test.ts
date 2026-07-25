import { describe, expect, it } from 'vitest'

import { GET } from '../decorators/verbs.js'
import { getMethodBuilders } from '../decorators/registrar/registrar.js'
import { noop } from '../noop.js'

function metadataOf(ctor: Function): object {
  return (ctor as unknown as { [Symbol.metadata]: object })[Symbol.metadata]
}

describe('subclassing', () => {
  it('a subclass does not automatically inherit the parent class decorated methods', () => {
    class Base {
      @GET('/base')
      base(): Promise<unknown> {
        return noop()
      }
    }

    class Child extends Base {
      @GET('/child')
      child(): Promise<unknown> {
        return noop()
      }
    }

    const baseMethods = getMethodBuilders(metadataOf(Base))
    const childMethods = getMethodBuilders(metadataOf(Child))

    expect(baseMethods.has('base')).toBe(true)
    expect(childMethods.has('child')).toBe(true)
    expect(childMethods.has('base')).toBe(false)
  })

  it('a subclass\'s own decorated methods never leak into or mutate the parent\'s registry entries', () => {
    class Base {
      @GET('/base')
      base(): Promise<unknown> {
        return noop()
      }
    }

    class Child extends Base {
      @GET('/base/override')
      base2(): Promise<unknown> {
        return noop()
      }
    }

    const baseMethods = getMethodBuilders(metadataOf(Base))
    const childMethods = getMethodBuilders(metadataOf(Child))

    expect(baseMethods.get('base')?.toMethodSpec().path).toBe('/base')
    expect(baseMethods.has('base2')).toBe(false)
    expect(childMethods.get('base2')?.toMethodSpec().path).toBe('/base/override')
  })
})
