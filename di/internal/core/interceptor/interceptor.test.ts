import { describe, expect, it, vi } from 'vitest'

import { newBinding, Binding } from '../../../binding.js'
import { ResolutionContext } from '../../../resolution_context.js'
import {
  afterInitInterceptor,
  beforeInitInterceptor,
  methodInjectorInterceptor,
  postConstructInterceptor,
  propertyInjectorInterceptor,
} from './index.js'

function makeCtx(binding: Binding): ResolutionContext {
  return { binding, container: null as any, key: null as any }
}

describe('postConstructInterceptor', () => {
  const intercept = postConstructInterceptor()

  it('returns null without calling postConstruct', () => {
    const postConstruct = vi.fn()
    const ctx = makeCtx(newBinding({ postConstruct }))
    expect(intercept(ctx, null as any)).toBeNull()
    expect(postConstruct).not.toHaveBeenCalled()
  })

  it('returns undefined without calling postConstruct', () => {
    const postConstruct = vi.fn()
    const ctx = makeCtx(newBinding({ postConstruct }))
    expect(intercept(ctx, undefined as any)).toBeUndefined()
    expect(postConstruct).not.toHaveBeenCalled()
  })

  it('returns instance unchanged when binding has no postConstruct', () => {
    const instance = { value: 1 }
    const ctx = makeCtx(newBinding())
    expect(intercept(ctx, instance)).toBe(instance)
  })

  it('calls postConstruct with instance and returns instance', () => {
    const postConstruct = vi.fn()
    const instance = { value: 42 }
    const ctx = makeCtx(newBinding({ postConstruct }))
    const result = intercept(ctx, instance)
    expect(postConstruct).toHaveBeenCalledOnce()
    expect(postConstruct).toHaveBeenCalledWith(instance)
    expect(result).toBe(instance)
  })
})

describe('propertyInjectorInterceptor', () => {
  const intercept = propertyInjectorInterceptor()

  it('returns null without calling resolvers', () => {
    const resolver = vi.fn()
    const ctx = makeCtx(newBinding({ propertyResolvers: new Map([['prop', resolver]]) }))
    expect(intercept(ctx, null as any)).toBeNull()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('returns undefined without calling resolvers', () => {
    const resolver = vi.fn()
    const ctx = makeCtx(newBinding({ propertyResolvers: new Map([['prop', resolver]]) }))
    expect(intercept(ctx, undefined as any)).toBeUndefined()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('returns instance unchanged when propertyResolvers is empty', () => {
    const instance = { a: 0 }
    const ctx = makeCtx(newBinding())
    expect(intercept(ctx, instance)).toBe(instance)
  })

  it('resolves and sets a single property', () => {
    const resolver = vi.fn().mockReturnValue('resolved')
    const instance: Record<string, unknown> = {}
    const ctx = makeCtx(newBinding({ propertyResolvers: new Map([['prop', resolver]]) }))
    intercept(ctx, instance)
    expect(resolver).toHaveBeenCalledOnce()
    expect(instance.prop).toBe('resolved')
  })

  it('resolves and sets multiple properties', () => {
    const resolverA = vi.fn().mockReturnValue('a')
    const resolverB = vi.fn().mockReturnValue('b')
    const instance: Record<string, unknown> = {}
    const ctx = makeCtx(
      newBinding({
        propertyResolvers: new Map([
          ['propA', resolverA],
          ['propB', resolverB],
        ]),
      }),
    )
    intercept(ctx, instance)
    expect(instance.propA).toBe('a')
    expect(instance.propB).toBe('b')
  })
})

describe('methodInjectorInterceptor', () => {
  const intercept = methodInjectorInterceptor()

  it('returns null without calling resolvers', () => {
    const resolver = vi.fn()
    const ctx = makeCtx(newBinding({ methodResolvers: new Map([['init', [resolver]]]) }))
    expect(intercept(ctx, null as any)).toBeNull()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('returns undefined without calling resolvers', () => {
    const resolver = vi.fn()
    const ctx = makeCtx(newBinding({ methodResolvers: new Map([['init', [resolver]]]) }))
    expect(intercept(ctx, undefined as any)).toBeUndefined()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('returns instance unchanged when methodResolvers is empty', () => {
    const instance = {}
    const ctx = makeCtx(newBinding())
    expect(intercept(ctx, instance)).toBe(instance)
  })

  it('calls method with no args when resolver list is empty', () => {
    const method = vi.fn()
    const instance = { init: method }
    const ctx = makeCtx(newBinding({ methodResolvers: new Map([['init', []]]) }))
    intercept(ctx, instance)
    expect(method).toHaveBeenCalledOnce()
    expect(method).toHaveBeenCalledWith()
  })

  it('calls method with resolved args', () => {
    const method = vi.fn()
    const resolverA = vi.fn().mockReturnValue('depA')
    const resolverB = vi.fn().mockReturnValue('depB')
    const instance = { init: method }
    const ctx = makeCtx(newBinding({ methodResolvers: new Map([['init', [resolverA, resolverB]]]) }))
    intercept(ctx, instance)
    expect(method).toHaveBeenCalledWith('depA', 'depB')
  })

  it('calls multiple methods', () => {
    const methodA = vi.fn()
    const methodB = vi.fn()
    const resolverA = vi.fn().mockReturnValue(1)
    const resolverB = vi.fn().mockReturnValue(2)
    const instance = { a: methodA, b: methodB }
    const ctx = makeCtx(
      newBinding({
        methodResolvers: new Map([
          ['a', [resolverA]],
          ['b', [resolverB]],
        ]),
      }),
    )
    intercept(ctx, instance)
    expect(methodA).toHaveBeenCalledWith(1)
    expect(methodB).toHaveBeenCalledWith(2)
  })
})

describe('beforeInitInterceptor', () => {
  it('delegates to postProcessor.beforeInit and returns result', () => {
    const transformed = { transformed: true }
    const beforeInit = vi.fn().mockReturnValue(transformed)
    const afterInit = vi.fn()
    const postProcessor = { beforeInit, afterInit }
    const intercept = beforeInitInterceptor(postProcessor)
    const instance = { original: true }
    const ctx = makeCtx(newBinding())
    const result = intercept(ctx, instance)
    expect(beforeInit).toHaveBeenCalledOnce()
    expect(beforeInit).toHaveBeenCalledWith(ctx, instance)
    expect(result).toBe(transformed)
  })
})

describe('afterInitInterceptor', () => {
  it('delegates to postProcessor.afterInit and returns result', () => {
    const transformed = { transformed: true }
    const afterInit = vi.fn().mockReturnValue(transformed)
    const beforeInit = vi.fn()
    const postProcessor = { beforeInit, afterInit }
    const intercept = afterInitInterceptor(postProcessor)
    const instance = { original: true }
    const ctx = makeCtx(newBinding())
    const result = intercept(ctx, instance)
    expect(afterInit).toHaveBeenCalledOnce()
    expect(afterInit).toHaveBeenCalledWith(ctx, instance)
    expect(result).toBe(transformed)
  })
})
