import { describe, expect } from 'vitest'
import { it, fc } from '@fast-check/vitest'
import { CaffeineIoC } from '../../container.js'
import { ErrUnresolvableDependencies } from '../../errors.js'
import { buildAcyclicEdges, buildDiFromEdges } from './helpers/cycle_di_builder.js'

function maxAcyclicEdges(nodeCount: number): number {
  let total = 0
  for (let i = 1; i < nodeCount; i++) {
    total += i
  }
  return total
}

describe('ensureResolvable (property)', function () {
  it.prop([fc.integer({ min: 1, max: 5 }), fc.array(fc.boolean(), { minLength: 0, maxLength: 15 })], { numRuns: 100 })(
    'closed manual-bind graph does not throw',
    (nodeCount, mask) => {
      const edgeCount = maxAcyclicEdges(nodeCount)
      const edgeMask = mask.slice(0, edgeCount)
      while (edgeMask.length < edgeCount) {
        edgeMask.push(false)
      }

      const di = buildDiFromEdges(edgesWithAllMaskTrue(nodeCount, edgeMask), false)
      expect(() => di.assertResolvable()).not.toThrow()
    },
  )

  it.prop([fc.string({ minLength: 1, maxLength: 12 })], { numRuns: 50 })(
    'missing required dependency produces an issue mentioning the key',
    missingKey => {
      const di = new CaffeineIoC({ decorators: false })
      di.bind('svc')
        .toFunction((_: unknown) => ({}), [missingKey])

      let caught: ErrUnresolvableDependencies | undefined
      try {
        di.assertResolvable()
      } catch (e) {
        caught = e as ErrUnresolvableDependencies
      }

      expect(caught)
        .toBeInstanceOf(ErrUnresolvableDependencies)
      expect(caught!.issues)
        .toHaveLength(1)
      expect(caught!.issues[0])
        .toContain(missingKey)
    },
  )

  it('optional missing dependency does not throw', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind('svc')
      .toFunction((_: unknown) => ({}), [{ key: 'missing', optional: true }])

    expect(() => di.assertResolvable()).not.toThrow()
  })
})

function edgesWithAllMaskTrue(nodeCount: number, mask: boolean[]) {
  return buildAcyclicEdges(nodeCount, mask)
}
