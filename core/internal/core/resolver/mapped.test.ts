import { describe, it, expect } from 'vitest'
import { DiCaf } from '../../../container.js'
import { ErrMissingInjectionKey, ErrNoResolutionForKey } from '../../../errors.js'
import { BuiltInResolvers } from '../../../injection_resolver.js'
import { mapped, optional } from '../../../injection.js'
import { mappedFactory } from './index.js'

function ctx(container: DiCaf, descriptor: ReturnType<typeof mapped | typeof optional>, key: any = 'Consumer') {
  return { container, descriptor, key, kind: 'constructor' as const, member: '', index: 0 }
}

describe('mappedFactory', function () {
  describe('validation', function () {
    it('should throw ErrMissingInjectionKey when ctx.key is absent', function () {
      const kKey = Symbol('map-no-ctx-key')
      const di = new DiCaf({ decorators: false })

      expect(() => mappedFactory(ctx(di, mapped(kKey), null)))
        .toThrow(ErrMissingInjectionKey)
    })

    it('should throw ErrMissingInjectionKey when descriptor has no key', function () {
      const di = new DiCaf({ decorators: false })

      expect(() => mappedFactory({
        container: di,
        descriptor: { resolver: BuiltInResolvers.MAP },
        key: 'Consumer',
        kind: 'constructor',
        member: '',
        index: 0,
      })).toThrow(ErrMissingInjectionKey)
    })

    it('should throw ErrNoResolutionForKey when no bindings exist and injection is required', function () {
      const kAbsent = Symbol('map-absent-required')
      const di = new DiCaf({ decorators: false })

      expect(() => mappedFactory(ctx(di, mapped(kAbsent))))
        .toThrow(ErrNoResolutionForKey)
    })

    it('should return undefined when no bindings exist and injection is optional', function () {
      const kAbsent = Symbol('map-absent-optional')
      const di = new DiCaf({ decorators: false })

      const resolver = mappedFactory(ctx(di, optional(mapped(kAbsent))))
      expect(resolver()).toBeUndefined()
    })
  })

  describe('resolution', function () {
    it('should return a Map with entries for each named binding', async function () {
      abstract class Widget {}
      class ButtonWidget extends Widget {}
      class InputWidget extends Widget {}

      const di = new DiCaf({ decorators: false })
      di.bind(ButtonWidget).toSelf()
        .extends(Widget)
        .names('button')
      di.bind(InputWidget).toSelf()
        .extends(Widget)
        .names('input')
      await di.init()

      const resolver = mappedFactory(ctx(di, mapped(Widget)))
      const result = resolver() as Map<string, Widget>

      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(2)
      expect(result.get('button')).toBeInstanceOf(ButtonWidget)
      expect(result.get('input')).toBeInstanceOf(InputWidget)
    })

    it('should exclude bindings that have no names', async function () {
      abstract class Store {}
      class StoreA extends Store {}
      class StoreB extends Store {}

      const di = new DiCaf({ decorators: false })
      di.bind(StoreA).toSelf()
        .extends(Store)
      di.bind(StoreB).toSelf()
        .extends(Store)
      await di.init()

      const resolver = mappedFactory(ctx(di, mapped(Store)))
      const result = resolver() as Map<unknown, unknown>

      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(0)
    })

    it('should include only named bindings when mixed with unnamed ones', async function () {
      abstract class Plugin {}
      class PluginA extends Plugin {}
      class PluginB extends Plugin {}

      const di = new DiCaf({ decorators: false })
      di.bind(PluginA).toSelf()
        .extends(Plugin)
        .names('alpha')
      di.bind(PluginB).toSelf()
        .extends(Plugin)
      await di.init()

      const resolver = mappedFactory(ctx(di, mapped(Plugin)))
      const result = resolver() as Map<string, Plugin>

      expect(result.size).toBe(1)
      expect(result.get('alpha')).toBeInstanceOf(PluginA)
    })
  })
})
