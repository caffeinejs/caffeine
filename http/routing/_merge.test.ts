import { describe, it, expect } from 'vitest'
import { RouteGroupBuilder, RouteBuilder } from './builder.js'

const kSym = Symbol('test')

describe('RouteGroupBuilder cumulative merge', () => {
  it('merges objects on the same config key', () => {
    const router = new RouteGroupBuilder()
      .config('cors', { origin: 'http://a.com' })
      .config('cors', { methods: ['GET'] })
      .toRouteGroup()

    expect(router.config?.get('cors')).toEqual({ origin: 'http://a.com', methods: ['GET'] })
  })

  it('merges objects on the same options key', () => {
    const router = new RouteGroupBuilder()
      .options('compress', { threshold: 100 })
      .options('compress', { encodings: ['gzip'] })
      .toRouteGroup()

    expect(router.options?.get('compress')).toEqual({ threshold: 100, encodings: ['gzip'] })
  })

  it('overwrites on primitive config key', () => {
    const router = new RouteGroupBuilder()
      .config('x', 1)
      .config('x', 2)
      .toRouteGroup()

    expect(router.config?.get('x')).toBe(2)
  })

  it('overwrites on type mismatch', () => {
    const router = new RouteGroupBuilder()
      .options('compress', { threshold: 100 })
      .options('compress', false as any)
      .toRouteGroup()

    expect(router.options?.get('compress')).toBe(false)
  })
})

describe('RouteBuilder cumulative merge', () => {
  it('merges objects on the same config key', () => {
    const route = new RouteBuilder()
      .config('cors', { origin: 'http://a.com' })
      .config('cors', { methods: ['GET'] })
      .toRoute()

    expect(route.config?.get('cors')).toEqual({ origin: 'http://a.com', methods: ['GET'] })
  })

  it('concats arrays on the same extras key', () => {
    const route = new RouteBuilder()
      .extras(kSym, [1, 2])
      .extras(kSym, [3])
      .toRoute()

    expect(route.extras?.get(kSym)).toEqual([1, 2, 3])
  })

  it('overwrites on primitive extras key', () => {
    const route = new RouteBuilder()
      .extras(kSym, true)
      .extras(kSym, false)
      .toRoute()

    expect(route.extras?.get(kSym)).toBe(false)
  })

  it('overwrites on primitive config key', () => {
    const route = new RouteBuilder()
      .config('x', 1)
      .config('x', 2)
      .toRoute()

    expect(route.config?.get('x')).toBe(2)
  })
})
