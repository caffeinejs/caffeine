import { randomUUID } from 'node:crypto'
import { describe, expect } from 'vitest'
import { it, fc } from '@fast-check/vitest'
import { CaffeineIoC } from '../../container.js'
import { Scopes } from '../../scope.js'

class SingletonSvc {
  readonly id: string = randomUUID()
}

class TransientSvc {
  readonly id: string = randomUUID()
}

describe('scope semantics (property)', function () {
  it.prop([fc.integer({ min: 2, max: 5 })], { numRuns: 50 })(
    'singleton returns the same instance on repeated get',
    async runs => {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(SingletonSvc)
        .toSelf()
        .lifetime(Scopes.SINGLETON)
      await di.init()

      let first: SingletonSvc | undefined
      for (let i = 0; i < runs; i++) {
        const instance = di.get(SingletonSvc)
        if (first === undefined) {
          first = instance
        } else {
          expect(instance)
            .toBe(first)
        }
      }
    },
  )

  it.prop([fc.integer({ min: 2, max: 5 })], { numRuns: 50 })(
    'transient returns distinct instances on repeated get',
    async runs => {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(TransientSvc)
        .toSelf()
        .lifetime(Scopes.TRANSIENT)
      await di.init()

      const instances = new Set<string>()
      for (let i = 0; i < runs; i++) {
        instances.add(di.get(TransientSvc).id)
      }

      expect(instances.size)
        .toBe(runs)
    },
  )

  it.prop([fc.integer({ min: 2, max: 4 })], { numRuns: 20 })(
    'separate containers yield separate singleton instances',
    async containerCount => {
      const ids: string[] = []

      for (let i = 0; i < containerCount; i++) {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(SingletonSvc)
          .toSelf()
          .lifetime(Scopes.SINGLETON)
        await di.init()
        ids.push(di.get(SingletonSvc).id)
      }

      expect(new Set(ids).size)
        .toBe(containerCount)
    },
  )
})
