import { describe, expect, it } from 'vitest'

import {
  configureAPIAndRegisterMethods,
  configureClass,
  configureMethod,
  getAPI,
  getClassBuilder,
  getMethodBuilders,
} from '../decorators/registrar/registrar.js'

function methodContext(metadata: object, name: string | symbol): ClassMethodDecoratorContext {
  return { metadata, name, kind: 'method' } as unknown as ClassMethodDecoratorContext
}

function fieldContext(metadata: object, name: string | symbol): ClassFieldDecoratorContext {
  return { metadata, name, kind: 'field' } as unknown as ClassFieldDecoratorContext
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

  it('configureMethod records kind from the context, for both method and field contexts', () => {
    const metadata = {}

    configureMethod(methodContext(metadata, 'asMethod'), () => {})
    configureMethod(fieldContext(metadata, 'asField'), () => {})

    expect(getMethodBuilders(metadata).get('asMethod')?.toMethodSpec().kind).toBe('method')
    expect(getMethodBuilders(metadata).get('asField')?.toMethodSpec().kind).toBe('field')
  })

  it('configureMethod records kind regardless of which decorator call triggers it first', () => {
    const metadata = {}

    // Simulates @Params (no-op mutator) running before @GET on a field-declared operation.
    configureMethod(fieldContext(metadata, 'op'), () => {})
    configureMethod(fieldContext(metadata, 'op'), spec => spec.httpMethod('GET'))

    expect(getMethodBuilders(metadata).get('op')?.toMethodSpec().kind).toBe('field')
  })

  it('configureAPIAndRegisterMethods drains methods registered before it runs, keyed by the target constructor', () => {
    const metadata = {}
    function TargetAPI() {}

    configureMethod(methodContext(metadata, 'get'), spec => spec.httpMethod('GET'))
    configureAPIAndRegisterMethods(classContext(metadata), TargetAPI, spec => spec.path('/users'))

    const entry = getAPI(TargetAPI)

    expect(entry?.classSpec.path).toBe('/users')
    expect(entry?.methods.get('get')?.toMethodSpec().httpMethod).toBe('GET')
  })

  it('getAPI returns undefined for a constructor that was never drained', () => {
    expect(getAPI(function Unregistered() {})).toBeUndefined()
  })

  it("a second, unrelated target constructor never sees another class's drained methods", () => {
    const metadataA = {}
    const metadataB = {}
    function APIA() {}
    function APIB() {}

    configureMethod(methodContext(metadataA, 'a'), spec => spec.httpMethod('GET'))
    configureAPIAndRegisterMethods(classContext(metadataA), APIA, spec => spec.path('/a'))

    configureMethod(methodContext(metadataB, 'b'), spec => spec.httpMethod('POST'))
    configureAPIAndRegisterMethods(classContext(metadataB), APIB, spec => spec.path('/b'))

    expect(getAPI(APIA)?.methods.has('b')).toBe(false)
    expect(getAPI(APIB)?.methods.has('a')).toBe(false)
  })
})
