import { describe, it, expect, vi } from 'vitest'

import { Binding, newBinding } from '../../../binding.js'
import { Factory } from '../../../factory.js'
import { ResolutionContext } from '../../../resolution_context.js'
import { SingletonScope } from './singleton.js'

describe('SingletonScope — falsy value caching', function () {
  function makeCtx(binding: Binding): ResolutionContext {
    return { binding, container: null as any, key: null as any }
  }

  it('should cache false and return it on subsequent resolutions', function () {
    const scope = new SingletonScope()
    const spy = vi.fn<() => boolean>().mockReturnValue(false)
    const factory: Factory<boolean> = () => spy()
    const binding = newBinding({ id: 1 } as any)

    const first = scope.provide(makeCtx(binding), factory)
    const second = scope.provide(makeCtx(binding), factory)

    expect(first).toBe(false)
    expect(second).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('should cache 0 and return it on subsequent resolutions', function () {
    const scope = new SingletonScope()
    const spy = vi.fn<() => number>().mockReturnValue(0)
    const factory: Factory<number> = () => spy()
    const binding = newBinding({ id: 2 } as any)

    const first = scope.provide(makeCtx(binding), factory)
    const second = scope.provide(makeCtx(binding), factory)

    expect(first).toBe(0)
    expect(second).toBe(0)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('should cache null and return it on subsequent resolutions', function () {
    const scope = new SingletonScope()
    const spy = vi.fn<() => null>().mockReturnValue(null)
    const factory: Factory<null> = () => spy()
    const binding = newBinding({ id: 3 } as any)

    const first = scope.provide(makeCtx(binding), factory)
    const second = scope.provide(makeCtx(binding), factory)

    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('should cache empty string and return it on subsequent resolutions', function () {
    const scope = new SingletonScope()
    const spy = vi.fn<() => string>().mockReturnValue('')
    const factory: Factory<string> = () => spy()
    const binding = newBinding({ id: 4 } as any)

    const first = scope.provide(makeCtx(binding), factory)
    const second = scope.provide(makeCtx(binding), factory)

    expect(first).toBe('')
    expect(second).toBe('')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('should call factory again after reset()', function () {
    const scope = new SingletonScope()
    const spy = vi.fn<() => boolean>().mockReturnValue(false)
    const factory: Factory<boolean> = () => spy()
    const binding = newBinding({ id: 5 } as any)

    scope.provide(makeCtx(binding), factory)
    scope.reset(binding)
    scope.provide(makeCtx(binding), factory)

    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('should report has() as false after reset()', function () {
    const scope = new SingletonScope()
    const spy = vi.fn<() => boolean>().mockReturnValue(false)
    const factory: Factory<boolean> = () => spy()
    const binding = newBinding({ id: 6 } as any)

    scope.provide(makeCtx(binding), factory)
    expect(scope.cachedInstance(binding)).not.toBeUndefined()

    scope.reset(binding)
    expect(scope.cachedInstance(binding)).toBeUndefined()
  })

  it('should return false for lazy', function () {
    expect(new SingletonScope().lazy).toBe(false)
  })
})
