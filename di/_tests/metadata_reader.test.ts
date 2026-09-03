import { describe, it, expect, vi } from 'vitest'
import { Binding } from '../binding.js'
import { CaffeineIoC } from '../container.js'
import { InjectionDescriptor } from '../injection.js'
import { InjectionToken, token } from '../key.js'
import { MetadataReader } from '../metadata_reader.js'

const Symbols = {
  injections: token<any>(Symbol('di_injections')),
}

const builtInMetadataReader: MetadataReader = (key: any): Partial<Binding> => {
  if (typeof key !== 'function') {
    return {}
  }

  const symbols = Object.getOwnPropertySymbols(key)
  const kDeps = symbols.find(x => x === Symbols.injections)
  if (!kDeps) {
    return {}
  }

  const deps = key[kDeps]
  const injections = new Array<InjectionDescriptor>(deps.length)

  for (let i = 0; i < deps.length; i++) {
    const d = deps[i]
    if (typeof d === 'object') {
      injections[i] = d
    } else {
      injections[i] = { key: d }
    }
  }

  if (injections) {
    return { injections }
  }

  return {}
}

describe('Custom Binding Metadata', function () {
  describe('when using a static factory method with Symbols.injections', function () {
    const kNm = token<any>(Symbol('nm'))

    class Dep {}

    class Opt {}

    class Nm {}

    class Root {
      constructor(
        readonly dep: any,
        readonly nm: any,
        readonly opt?: any,
      ) {}

      static get [Symbols.injections]() {
        return [Dep, kNm, { key: Opt, optional: true }]
      }
    }

    it('should resolve dependencies based on the return of the Symbols.injections function', async function () {
      const di = new CaffeineIoC({ metadataReader: builtInMetadataReader })

      di.bind(Dep, t => t
        .toSelf())
      di.bind(Nm, t => t
        .toSelf()
        .names(kNm))
      di.bind(Root, t => t
        .toSelf())
      await di.init()

      const root = di.get(Root)

      expect(root)
        .toBeInstanceOf(Root)
      expect(root.dep)
        .toBeInstanceOf(Dep)
      expect(root.nm)
        .toBeInstanceOf(Nm)
      expect(root.opt)
        .toBeUndefined()
    })
  })

  describe('when using a custom metadata reader', function () {
    it('should allow set an alternative metadata reader', function () {
      const spy = vi.fn()

      const custom: MetadataReader = (key: InjectionToken): Partial<Binding> => {
        spy()
        return builtInMetadataReader(key)
      }

      class Svc {}
      const di = new CaffeineIoC({ metadataReader: custom, decorators: false })
      di.bind(Svc, t => t
        .toSelf())

      expect(spy)
        .toHaveBeenCalled()
    })
  })
})
