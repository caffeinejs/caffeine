import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { type Options } from '../container_interface.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Injectable } from '../decorators/injectable.js'
import { Profile } from '../decorators/profile.js'
import { $i } from '../injection.js'
import { token } from '../key.js'
import { mod } from '../module.js'
import { type Snapshot } from '../snapshot.js'

function newContainerFromSnapshot(snap: Snapshot, options?: Partial<Options>): CaffeineIoC {
  const di = new CaffeineIoC(options)
  di.restore(snap)
  return di
}

const kDb = token<string>(Symbol('db'))
const kAPI = token<string>(Symbol('api'))

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

    // The values are not a binding, so a container rebuilt from a snapshot would otherwise lose every $i.config.
    it('carries the values, which restore() binds into the new container', async function () {
      class Svc {
        constructor(readonly host: string) {}
      }

      const values = { host: 'db.local' }
      const di = new CaffeineIoC({ decorators: false })
      di.bindConfig(values)
      di.bind(Svc, t => t.toClass(Svc, [$i.config<typeof values>(c => c.host)]))
      await di.init()

      const testDi = newContainerFromSnapshot(di.snapshot())
      await testDi.init()

      expect(testDi.values).toBe(values)
      expect(testDi.get(Svc).host).toBe('db.local')
    })

    it('restoring a snapshot taken without values keeps the values the container has', function () {
      const values = { host: 'own' }
      const testDi = new CaffeineIoC({ decorators: false })
      testDi.bindConfig(values)

      testDi.restore(new CaffeineIoC({ decorators: false }).snapshot())

      expect(testDi.values).toBe(values)
    })
  })

  describe('test doubles via snapshot', function () {
    it('override replaces snapshot binding in new container', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kDb, t => t.toValue('real-db'))
      await di.init()

      const testDi = newContainerFromSnapshot(di.snapshot())
      testDi.rebind(kDb, t => t.toValue('mock-db'))
      await testDi.init()

      expect(testDi.get(kDb)).toBe('mock-db')
    })

    it('snapshot container is independent — overrides do not affect original', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kDb, t => t.toValue('real-db'))
      await di.init()

      const testDi = newContainerFromSnapshot(di.snapshot())
      testDi.rebind(kDb, t => t.toValue('mock-db'))
      await testDi.init()

      expect(di.get(kDb)).toBe('real-db')
      expect(testDi.get(kDb)).toBe('mock-db')
    })
  })

  // A snapshot holds what the container was told, not what it registered: the restored container registers the
  // decorated bindings, runs the modules and decides profiles and conditions itself.
  describe('declarations', function () {
    const kFlag = token<boolean>(Symbol('snap-flag'))
    const kModule = token<string>(Symbol('snap-module'))

    @Injectable()
    @Profile('snap-decl')
    class SnapDecorated {}

    @Injectable()
    @Profile('snap-decl')
    @ConditionalOn(ctx => ctx.container.has(kFlag))
    class SnapConditional {}

    const snapModule = mod('snap-module', c => c.bind(kModule, t => t.toValue('from-module')))

    function source(): CaffeineIoC {
      const di = new CaffeineIoC({ profiles: ['snap-decl'], modules: [snapModule] })
      di.bind(kDb, t => t.toValue('db-url'))
      return di
    }

    async function keysOf(snap: Snapshot): Promise<unknown[]> {
      const di = newContainerFromSnapshot(snap)
      await di.init()
      return [...di.entries()].map(([key]) => key)
    }

    it('carries the modules, the profiles and whether decorated bindings are registered', function () {
      const snap = source().snapshot()

      expect(snap.modules).toEqual([snapModule])
      expect(snap.profiles).toEqual(['snap-decl'])
      expect(snap.decorators).toBe(true)
      expect(snap.size).toBe(1)
    })

    it('restores to the same bindings whether taken before or after init()', async function () {
      const before = source().snapshot()

      const initialized = source()
      await initialized.init()
      const after = initialized.snapshot()

      const keys = await keysOf(before)

      expect(keys).toEqual(expect.arrayContaining([kDb, kModule, SnapDecorated]))
      expect(new Set(await keysOf(after))).toEqual(new Set(keys))
    })

    it('does not carry a module binding twice, since the module runs again', async function () {
      const initialized = source()
      await initialized.init()

      const testDi = newContainerFromSnapshot(initialized.snapshot())
      await testDi.init()

      expect(testDi.get(kModule)).toBe('from-module')
    })

    it('leaves conditions to the restored container', async function () {
      const initialized = source()
      await initialized.init()
      expect(initialized.has(SnapConditional)).toBe(false)

      const testDi = newContainerFromSnapshot(initialized.snapshot())
      testDi.bind(kFlag, t => t.toValue(true))
      await testDi.init()

      expect(testDi.has(SnapConditional)).toBe(true)
    })

    it('keeps a rebind() a replacement', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kDb, t => t.toValue('first'))
      di.rebind(kDb, t => t.toValue('second'))

      const testDi = newContainerFromSnapshot(di.snapshot())
      await testDi.init()

      expect(testDi.get(kDb)).toBe('second')
    })

    it('is not changed by what the restored container does with it', async function () {
      const snap = source().snapshot()

      const first = newContainerFromSnapshot(snap)
      await first.init()
      const second = newContainerFromSnapshot(snap)
      await second.init()

      expect(second.get(kDb)).toBe('db-url')
      expect(snap.size).toBe(1)
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
      expect(testDi.profiles.has('prod')).toBe(true)
      expect(testDi.get(kDb)).toBe('prod-db')
    })
  })
})
