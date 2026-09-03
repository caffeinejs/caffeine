import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../../../container.js'
import { ErrMissingInjectionKey, ErrNoResolutionForKey } from '../../../errors.js'
import { $i } from '../../../injection.js'
import { BuiltInStages } from '../../../injection_resolver.js'
import { token } from '../../../key.js'
import { compileChain } from './index.js'

function ctx(
  container: CaffeineIoC,
  descriptor: ReturnType<typeof $i.mapped | typeof $i.optional>,
  key: any = 'Consumer',
) {
  return { container, descriptor, key, kind: 'constructor' as const, member: '', index: 0 }
}

describe('the map terminal', function () {
  describe('validation', function () {
    // The consumer's own key used to be required here. Mapping never reads it — only the injected key matters —
    // so an injection that stands on its own now resolves instead of failing.
    it('resolves without a consumer key', async function () {
      const kKey = token<Record<string, unknown>>(Symbol('map-no-ctx-key'))
      const di = new CaffeineIoC({ decorators: false })
      di.bind(token<string>('only'), t => t.toValue('one').names(kKey))
      await di.init()

      expect(compileChain(ctx(di, $i.mapped(kKey), null))()).toBeInstanceOf(Map)
    })

    it('should throw ErrMissingInjectionKey when descriptor has no key', function () {
      const di = new CaffeineIoC({ decorators: false })

      expect(() =>
        compileChain({
          container: di,
          descriptor: { stages: [{ name: BuiltInStages.MAP }] },
          key: token<Record<string, unknown>>('Consumer'),
          kind: 'constructor',
          member: '',
          index: 0,
        }),
      ).toThrow(ErrMissingInjectionKey)
    })

    it('should throw ErrNoResolutionForKey when no bindings exist and injection is required', function () {
      const kAbsent = token<Record<string, unknown>>(Symbol('map-absent-required'))
      const di = new CaffeineIoC({ decorators: false })

      expect(() => compileChain(ctx(di, $i.mapped(kAbsent)))).toThrow(ErrNoResolutionForKey)
    })

    it('should return undefined when no bindings exist and injection is optional', function () {
      const kAbsent = token<Record<string, unknown>>(Symbol('map-absent-optional'))
      const di = new CaffeineIoC({ decorators: false })

      const resolver = compileChain(ctx(di, $i.optional($i.mapped(kAbsent))))
      expect(resolver()).toBeUndefined()
    })
  })

  describe('resolution', function () {
    it('should return a Map with entries for each named binding', async function () {
      abstract class Widget {}
      class ButtonWidget extends Widget {}
      class InputWidget extends Widget {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(ButtonWidget, t => t.toSelf().extends(Widget).names('button'))
      di.bind(InputWidget, t => t.toSelf().extends(Widget).names('input'))
      await di.init()

      const resolver = compileChain(ctx(di, $i.mapped(Widget)))
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

      const di = new CaffeineIoC({ decorators: false })
      di.bind(StoreA, t => t.toSelf().extends(Store))
      di.bind(StoreB, t => t.toSelf().extends(Store))
      await di.init()

      const resolver = compileChain(ctx(di, $i.mapped(Store)))
      const result = resolver() as Map<unknown, unknown>

      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(0)
    })

    it('should include only named bindings when mixed with unnamed ones', async function () {
      abstract class Plugin {}
      class PluginA extends Plugin {}
      class PluginB extends Plugin {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(PluginA, t => t.toSelf().extends(Plugin).names('alpha'))
      di.bind(PluginB, t => t.toSelf().extends(Plugin))
      await di.init()

      const resolver = compileChain(ctx(di, $i.mapped(Plugin)))
      const result = resolver() as Map<string, Plugin>

      expect(result.size).toBe(1)
      expect(result.get('alpha')).toBeInstanceOf(PluginA)
    })
  })
})
