import { describe, expect, it } from 'vitest'

import {
  configureClass,
  configureMethod,
  getClassBuilder,
  getDeclaringClasses,
  getMethodBuilders,
} from '../decorators/registrar/registrar.js'

function methodContext(metadata: object, name: string | symbol): ClassMethodDecoratorContext {
  return { metadata, name, kind: 'method' } as unknown as ClassMethodDecoratorContext
}

function fieldContext(metadata: object, name: string | symbol): ClassFieldDecoratorContext {
  return { metadata, name, kind: 'field' } as unknown as ClassFieldDecoratorContext
}

// A constructor owning `metadata` as its decorator metadata, as an emitter defines it once the class is decorated.
function owning<C extends Function>(C: C, metadata: object | null): C {
  Object.defineProperty(C, Symbol.metadata, { value: metadata, configurable: true, enumerable: true })
  return C
}

function classContext(metadata: object): ClassDecoratorContext {
  return { metadata, kind: 'class' } as unknown as ClassDecoratorContext
}

describe('registrar', () => {
  it('configureMethod returns the same MethodBuilder for repeated calls with the same metadata+name', () => {
    const metadata = {}

    const first = configureMethod(methodContext(metadata, 'get'), () => {})
    const second = configureMethod(methodContext(metadata, 'get'), () => {})

    expect(first).toBe(second)
  })

  it('configureMethod returns distinct MethodBuilder instances for different method names', () => {
    const metadata = {}

    const get = configureMethod(methodContext(metadata, 'get'), () => {})
    const post = configureMethod(methodContext(metadata, 'post'), () => {})

    expect(get).not.toBe(post)
  })

  it('two different metadata keys never share MethodBuilder entries (WeakMap identity isolation)', () => {
    const metadataA = {}
    const metadataB = {}

    configureMethod(methodContext(metadataA, 'get'), spec => spec.httpMethod('GET'))
    configureMethod(methodContext(metadataB, 'get'), spec => spec.httpMethod('POST'))

    expect(getMethodBuilders(metadataA).get('get')?.toMethodSpec().httpMethod).toBe('GET')
    expect(getMethodBuilders(metadataB).get('get')?.toMethodSpec().httpMethod).toBe('POST')
  })

  it('getMethodBuilders returns an empty map for a metadata key with no configured methods', () => {
    expect(getMethodBuilders({}).size).toBe(0)
  })

  it('configureClass reuses the same ClassBuilder across calls for the same metadata', () => {
    const metadata = {}

    configureClass(classContext(metadata), spec => spec.path('/first'))
    configureClass(classContext(metadata), spec => spec.path('/second'))

    expect(getClassBuilder(metadata)?.toClassSpec().path).toBe('/second')
  })

  it('two different metadata keys never share ClassBuilder entries', () => {
    const metadataA = {}
    const metadataB = {}

    configureClass(classContext(metadataA), spec => spec.path('/a'))
    configureClass(classContext(metadataB), spec => spec.path('/b'))

    expect(getClassBuilder(metadataA)?.toClassSpec().path).toBe('/a')
    expect(getClassBuilder(metadataB)?.toClassSpec().path).toBe('/b')
  })

  it('getClassBuilder returns undefined for a metadata key with no class-level configuration', () => {
    expect(getClassBuilder({})).toBeUndefined()
  })

  // `create()` stores each client's invoker under the key and the verb's wrapper reads it back, so every decorator on
  // one member has to see the same key, whichever of them runs first.
  it('gives each member one key, whichever decorator configures it first', () => {
    const metadata = {}

    const first = configureMethod(fieldContext(metadata, 'op'), () => {})
    const second = configureMethod(fieldContext(metadata, 'op'), spec => spec.httpMethod('GET'))

    expect(typeof first.key).toBe('symbol')
    expect(second.key).toBe(first.key)
  })

  // A subclass that redeclares `get` declares a second operation, and `super.get()` must still reach the first one.
  it('gives the same member name its own key in each class', () => {
    const base = configureMethod(methodContext({}, 'get'), () => {})
    const child = configureMethod(methodContext({}, 'get'), () => {})

    expect(child.key).not.toBe(base.key)
  })

  describe('getDeclaringClasses', () => {
    it('lists the classes that own fetchy metadata, the root first, and skips the others', () => {
      const baseMetadata = {}
      const childMetadata = {}
      configureClass(classContext(baseMetadata), spec => spec.api())
      configureMethod(methodContext(childMetadata, 'get'), spec => spec.httpMethod('GET'))

      const Base = owning(class {}, baseMetadata)
      class Mid extends Base {}
      const Child = owning(class extends Mid {}, childMetadata)

      const chain = getDeclaringClasses(Child)

      expect(chain.map(declaring => declaring.owner)).toEqual([Base, Child])
      expect(chain[0].classBuilder?.isAPI()).toBe(true)
      expect(chain[1].methods.map(method => method.name)).toEqual(['get'])
    })

    // tsc and esbuild link a subclass's metadata to its parent's. Reading through that link would serve the parent's
    // operations twice, once for each class, and only under those compilers.
    it("reads each class through the metadata it owns, never through the link to its parent's", () => {
      const baseMetadata = {}
      configureMethod(methodContext(baseMetadata, 'get'), spec => spec.httpMethod('GET'))
      const Base = owning(class {}, baseMetadata)

      const childMetadata = Object.create(baseMetadata) as object
      configureClass(classContext(childMetadata), spec => spec.api())
      const Child = owning(class extends Base {}, childMetadata)

      const chain = getDeclaringClasses(Child)

      expect(chain.map(declaring => declaring.owner)).toEqual([Base, Child])
      expect(chain.flatMap(declaring => declaring.methods.map(method => method.name))).toEqual(['get'])
    })

    it('skips a class whose own metadata is not an object', () => {
      const metadata = {}
      configureClass(classContext(metadata), spec => spec.api())
      const Base = owning(class {}, metadata)
      const Child = owning(class extends Base {}, null)

      expect(getDeclaringClasses(Child).map(declaring => declaring.owner)).toEqual([Base])
    })

    // A mixin that copies a class's statics copies its metadata too, which would serve the same operations twice.
    it('counts a metadata object owned by two classes once, for the one closest to the root', () => {
      const metadata = {}
      configureMethod(methodContext(metadata, 'get'), spec => spec.httpMethod('GET'))
      const Base = owning(class {}, metadata)
      const Copy = owning(class extends Base {}, metadata)

      expect(getDeclaringClasses(Copy).map(declaring => declaring.owner)).toEqual([Base])
    })
  })
})
