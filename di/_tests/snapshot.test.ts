import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { type Options } from '../container_interface.js'
import { token } from '../key.js'
import { type Snapshot } from '../snapshot.js'

function newContainerFromSnapshot(snap: Snapshot, options?: Partial<Options>): CaffeineIoC {
  const di = new CaffeineIoC({ decorators: false, ...options })
  di.restore(snap)
  return di
}

const kDb = token<string>(Symbol('db'))
const kAPI = token<string>(Symbol('api'))
const kLabel = token<Record<string, unknown>>(Symbol('label'))

describe('ContainerSnapshot', function () {
  describe('snapshot()', function () {
    it('captures pre-init value bindings — new container resolves correctly', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kDb, t => t.toValue('db-url'))

      const snap = di.snapshot()

      expect(snap.size).toBe(1)

      const testDi = newContainerFromSnapshot(snap)
      await testDi.init()

      expect(testDi.get(kDb)).toBe('db-url')
    })

    it('captures post-init value bindings — new container resolves correctly', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kDb, t => t.toValue('db-url'))
      await di.init()

      const snap = di.snapshot()

      expect(snap.size).toBe(1)

      const testDi = newContainerFromSnapshot(snap)
      await testDi.init()

      expect(testDi.get(kDb)).toBe('db-url')
    })

    it('excludes internal bindings from snapshot', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kDb, t => t.toValue('db-url'))
      await di.init()

      const snap = di.snapshot()

      expect(snap.size).toBe(1)
    })

    it('class bindings are re-compiled by new container', async function () {
      class Svc {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Svc, t => t.toClass(Svc))
      await di.init()

      const original = di.get(Svc)

      const testDi = newContainerFromSnapshot(di.snapshot())
      await testDi.init()

      const fromSnap = testDi.get(Svc)
      expect(fromSnap).toBeInstanceOf(Svc)
      expect(fromSnap).not.toBe(original)
    })

    it('class binding with symbol key resolves via factory in new container', async function () {
      const kSvc = token<Svc>(Symbol('svc'))

      class Svc {
        readonly tag = 'real'
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kSvc, t => t.toFactory(() => new Svc()))
      await di.init()

      const testDi = newContainerFromSnapshot(di.snapshot())
      await testDi.init()

      expect((testDi.get(kSvc) as Svc).tag).toBe('real')
    })

    it('multiple bindings are all captured', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kDb, t => t.toValue('db-url'))
      di.bind(kAPI, t => t.toValue('api-url'))
      await di.init()

      const snap = di.snapshot()

      expect(snap.size).toBe(2)

      const testDi = newContainerFromSnapshot(snap)
      await testDi.init()

      expect(testDi.get(kDb)).toBe('db-url')
      expect(testDi.get(kAPI)).toBe('api-url')
    })
  })

  describe('test doubles via snapshot', function () {
    it('override replaces snapshot binding in new container', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kDb, t => t.toValue('real-db'))
      await di.init()

      const testDi = newContainerFromSnapshot(di.snapshot())
      testDi.bind(kDb, t => t.toValue('mock-db'))
      await testDi.init()

      expect(testDi.get(kDb)).toBe('mock-db')
    })

    it('snapshot container is independent — overrides do not affect original', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kDb, t => t.toValue('real-db'))
      await di.init()

      const testDi = newContainerFromSnapshot(di.snapshot())
      testDi.bind(kDb, t => t.toValue('mock-db'))
      await testDi.init()

      expect(di.get(kDb)).toBe('real-db')
      expect(testDi.get(kDb)).toBe('mock-db')
    })
  })

  describe('filter() and exclude()', function () {
    it('exclude() removes specified keys', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kDb, t => t.toValue('db-url'))
      di.bind(kAPI, t => t.toValue('api-url'))
      await di.init()

      const snap = di.snapshot().exclude(kDb)

      expect(snap.size).toBe(1)

      const testDi = newContainerFromSnapshot(snap)
      await testDi.init()

      expect(testDi.has(kAPI)).toBe(true)
      expect(testDi.has(kDb)).toBe(false)
    })

    it('filter() keeps only matching bindings', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kDb, t => t.toValue('db-url').labels(kLabel))
      di.bind(kAPI, t => t.toValue('api-url'))
      await di.init()

      const snap = di.snapshot().filter((_, binding) => binding.labels.includes(kLabel))

      expect(snap.size).toBe(1)

      const testDi = newContainerFromSnapshot(snap)
      await testDi.init()

      expect(testDi.has(kDb)).toBe(true)
      expect(testDi.has(kAPI)).toBe(false)
    })

    it('filter() returning false for all produces empty snapshot', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kDb, t => t.toValue('db-url'))
      await di.init()

      const snap = di.snapshot().filter(() => false)

      expect(snap.size).toBe(0)
    })
  })

  describe('newContainerFromSnapshot()', function () {
    it('accepts options that merge with snapshot', async function () {
      const di = new CaffeineIoC({ decorators: false, profiles: ['prod'] })
      di.bind(kDb, t => t.toValue('prod-db'))
      await di.init()

      const testDi = newContainerFromSnapshot(di.snapshot(), { profiles: ['test'] })
      await testDi.init()

      expect(testDi.profiles.has('test')).toBe(true)
      expect(testDi.get(kDb)).toBe('prod-db')
    })
  })
})
