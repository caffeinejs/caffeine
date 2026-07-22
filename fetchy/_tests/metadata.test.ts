import { describe, expect, it } from 'vitest'

import { allMethodMeta, classMeta, methodMeta, readClassMeta } from '../metadata.js'

function newMetadata(proto?: DecoratorMetadataObject): DecoratorMetadataObject {
  return Object.create(proto ?? null) as DecoratorMetadataObject
}

describe('metadata', () => {
  it('returns the same MethodMeta instance for repeated calls with the same name', () => {
    const metadata = newMetadata()

    const first = methodMeta(metadata, 'get')
    const second = methodMeta(metadata, 'get')

    expect(first).toBe(second)
  })

  it('returns distinct MethodMeta instances for different method names', () => {
    const metadata = newMetadata()

    const get = methodMeta(metadata, 'get')
    const post = methodMeta(metadata, 'post')

    expect(get).not.toBe(post)
  })

  it('clones an inherited method map instead of mutating the prototype', () => {
    const base = newMetadata()
    methodMeta(base, 'get')

    const child = newMetadata(base)
    methodMeta(child, 'post')

    expect(allMethodMeta(base).has('post')).toBe(false)
    expect(allMethodMeta(child).has('get')).toBe(true)
    expect(allMethodMeta(child).has('post')).toBe(true)
  })

  it('clones an inherited ClassMeta instead of mutating the prototype', () => {
    const base = newMetadata()
    classMeta(base).path = '/base'

    const child = newMetadata(base)
    classMeta(child).path = '/child'

    expect(readClassMeta(base)?.path).toBe('/base')
    expect(readClassMeta(child)?.path).toBe('/child')
  })

  it('allMethodMeta resolves inherited entries through the prototype chain without cloning', () => {
    const base = newMetadata()
    methodMeta(base, 'get')

    const child = newMetadata(base)

    expect(allMethodMeta(child).has('get')).toBe(true)
  })
})
