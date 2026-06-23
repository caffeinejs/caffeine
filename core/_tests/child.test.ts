import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DiCaf } from '../container.js'

describe('Named bindings visible in child containers', function () {
  it('should resolve a named string key registered only in the child', async function () {
    const parent = new DiCaf({ decorators: false })
    const child = parent.newChild()

    child.bind('child-key')
      .toValue('hello')
    await child.init()

    expect(child.get<string>('child-key'))
      .toEqual('hello')
  })

  it('should resolve a named symbol key registered only in the child', async function () {
    const parent = new DiCaf({ decorators: false })
    const child = parent.newChild()
    const k = Symbol('sym-child')

    child.bind(k)
      .toValue(42)
    await child.init()

    expect(child.get<number>(k))
      .toEqual(42)
  })

  it('should fall through to parent for a named key not in the child', async function () {
    const parent = new DiCaf({ decorators: false })
    parent.bind('parent-key')
      .toValue('from-parent')

    const child = parent.newChild()
    await child.init()

    expect(child.get<string>('parent-key'))
      .toEqual('from-parent')
  })

  it('should prefer child over parent when both have the same named key', async function () {
    const parent = new DiCaf({ decorators: false })
    parent.bind('shared')
      .toValue('parent-value')

    const child = parent.newChild()
    child.bind('shared')
      .toValue('child-value')
    await parent.init()
    await child.init()

    expect(child.get<string>('shared'))
      .toEqual('child-value')
    expect(parent.get<string>('shared'))
      .toEqual('parent-value')
  })
})

describe('Per-container scope instances', function () {
  class PerContainerSingleton {
    readonly id: string = randomUUID()
  }

  it('should give independent singleton instances across separate containers', async function () {
    const di1 = new DiCaf({ decorators: false })
    di1.bind(PerContainerSingleton)
      .toSelf()

    const di2 = new DiCaf({ decorators: false })
    di2.bind(PerContainerSingleton)
      .toSelf()
    await di1.init()
    await di2.init()

    const r1 = di1.get(PerContainerSingleton)
    const r2 = di2.get(PerContainerSingleton)

    expect(r1).not.toBe(r2)
  })
})

describe('Child', function () {
  describe('when child contains root', function () {
    describe('and parent contains injection dependency', function () {
      class Dep {
        readonly id: string = randomUUID()
      }

      class Svc {
        constructor(readonly dep: Dep) {}
      }

      it('should resolve requested type', async function () {
        const parent = new DiCaf()
        const child = parent.newChild()

        parent.bind(Dep)
          .toSelf()
        child.bind(Svc)
          .toSelf([Dep])
        await parent.init()
        await child.init()

        const parentDep = parent.get(Dep)
        const childDep = child.get(Dep)
        const svc = child.get(Svc)

        expect(parent.has(Dep))
          .toBeTruthy()
        expect(parent.has(Svc))
          .toBeFalsy()
        expect(child.has(Dep))
          .toBeTruthy()
        expect(child.has(Svc))
          .toBeTruthy()
        expect(parentDep)
          .toBeInstanceOf(Dep)
        expect(svc)
          .toBeInstanceOf(Svc)
        expect(svc.dep)
          .toBeInstanceOf(Dep)
        expect(parentDep)
          .toEqual(childDep)
      })
    })
  })
})
