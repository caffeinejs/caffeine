import { describe, expect, it } from 'vitest'

import { getMethodBuilders } from '../decorators/registrar/registrar.js'
import { GET } from '../decorators/verbs.js'
import { noop } from '../noop.js'
import { captureMetadata } from './capture_metadata.js'

describe('subclassing', () => {
  it('a subclass does not automatically inherit the parent class decorated methods', () => {
    const base = captureMetadata()
    const child = captureMetadata()

    @base.capture
    class Base {
      @GET('/base')
      base(): Promise<unknown> {
        return noop()
      }
    }

    @child.capture
    class Child extends Base {
      @GET('/child')
      child(): Promise<unknown> {
        return noop()
      }
    }

    const baseMethods = getMethodBuilders(base.metadata())
    const childMethods = getMethodBuilders(child.metadata())

    expect(baseMethods.has('base')).toBe(true)
    expect(childMethods.has('child')).toBe(true)
    expect(childMethods.has('base')).toBe(false)
  })

  it("a subclass's own decorated methods never leak into or mutate the parent's registry entries", () => {
    const base = captureMetadata()
    const child = captureMetadata()

    @base.capture
    class Base {
      @GET('/base')
      base(): Promise<unknown> {
        return noop()
      }
    }

    @child.capture
    class Child extends Base {
      @GET('/base/override')
      base2(): Promise<unknown> {
        return noop()
      }
    }

    const baseMethods = getMethodBuilders(base.metadata())
    const childMethods = getMethodBuilders(child.metadata())

    expect(baseMethods.get('base')?.toMethodSpec().path).toBe('/base')
    expect(baseMethods.has('base2')).toBe(false)
    expect(childMethods.get('base2')?.toMethodSpec().path).toBe('/base/override')
  })
})
