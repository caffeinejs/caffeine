import { describe, expect, it } from 'vitest'

import { configureClass, configureMethod, getClassBuilder, getMethodBuilders } from '../decorators/registrar/registrar.js'

function methodContext(metadata: object, name: string | symbol): ClassMethodDecoratorContext {
  return { metadata, name, kind: 'method' } as unknown as ClassMethodDecoratorContext
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
})
