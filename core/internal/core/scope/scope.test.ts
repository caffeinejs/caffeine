import { randomUUID } from 'node:crypto'
import { describe, it, afterAll, expect, vi } from 'vitest'
import { Binding } from '../../../binding.js'
import { Injectable } from '../../../decorators/injectable.js'
import { Lazy } from '../../../decorators/lazy.js'
import { Lifetime } from '../../../decorators/lifetime.js'
import { CaffeineIoC } from '../../../container.js'
import { ErrScopeAlreadyRegistered, ErrScopeNotRegistered } from '../../../errors.js'
import { Factory } from '../../../factory.js'
import { bindScope, hasScope, Scopes, Scope, unbindScope } from '../../../scope.js'
import { ResolutionContext } from '../../../resolution_context.js'

describe('Scoping', function () {
  const kCustomScopeID = Symbol('custom')
  const spy = vi.fn()

  class CustomScope implements Scope {
    readonly id: string = randomUUID()

    provide<T>(ctx: ResolutionContext, factory: Factory<T>): T {
      spy()
      return factory(ctx)
    }

    cachedInstance<T>(binding: Binding): T | undefined {
      return undefined
    }

    reset(_binding: Binding): void {
      //
    }

    configure(_binding: Binding): void {
      //
    }

    undo(_binding: Binding): void {
      //
    }

    get lazy(): boolean {
      return false
    }

    get durable(): boolean {
      return false
    }
  }

  @Injectable()
  @Lazy()
  @Lifetime(kCustomScopeID)
  class Dep {
    readonly id: string = randomUUID()
  }

  afterAll(() => {
    unbindScope(kCustomScopeID)
    unbindScope('none')
  })

  it('should fail when using an non-registered scope', function () {
    @Injectable()
    @Lifetime('none')
    class NonexistentScope {}

    try {
      new CaffeineIoC()
    } catch (e) {
      expect(e)
        .toBeInstanceOf(ErrScopeNotRegistered)
      expect(hasScope('none'))
        .toBeFalsy()
      return
    } finally {
      if (!hasScope('none')) {
        bindScope('none', () => ({
          provide<T>(ctx: ResolutionContext, factory: Factory<T>): T {
            return factory(ctx)
          },
          cachedInstance<T>(_binding: Binding): T | undefined {
            return undefined
          },
          reset(_binding: Binding): void {
            //
          },
          configure(_binding: Binding): void {
            //
          },
          undo(_binding: Binding): void {
            //
          },
          get lazy(): boolean {
            return false
          },
          get durable(): boolean {
            return false
          },
        }))
      }
    }

    throw new Error('should not reach here!')
  })

  it('should use scope specified with decorator when it is registered', async function () {
    const scope = new CustomScope()

    bindScope(kCustomScopeID, () => scope)

    const di = new CaffeineIoC()
    await di.init()
    const scoped1 = di.get(Dep)
    const scoped2 = di.get(Dep)

    expect(scoped1)
      .toBeInstanceOf(Dep)
    expect(scoped2)
      .toBeInstanceOf(Dep)
    expect(scoped1).not.toEqual(scoped2)
    expect(spy)
      .toHaveBeenCalledTimes(2)
  })

  it('should fail when registering a scope with an existing identifier', function () {
    expect(() =>
      bindScope(
        Scopes.SINGLETON,
        () =>
          new class implements Scope {
            provide<T>(ctx: ResolutionContext, factory: Factory<T>): T {
              return factory(ctx)
            }

            cachedInstance<T>(_binding: Binding): T | undefined {
              return undefined
            }

            reset(_binding: Binding): void {
              //
            }

            configure(_binding: Binding): void {
              //
            }

            undo(_binding: Binding): void {
              //
            }

            get lazy(): boolean {
              return false
            }

            get durable(): boolean {
              return false
            }
          }(),
      ),
    )
      .toThrow(ErrScopeAlreadyRegistered)
  })
})
