import { describe, expect } from 'vitest'
import { it, fc } from '@fast-check/vitest'
import { token } from '../../key.js'
import { CaffeineIoC } from '../../container.js'
import { ErrCircularDependency } from '../../errors.js'
import { $i } from '../../injection.js'
import { addBackEdge, buildAcyclicEdges, buildDiFromEdges } from './helpers/cycle_di_builder.js'

function maxAcyclicEdges(nodeCount: number): number {
  let total = 0
  for (let i = 1; i < nodeCount; i++) {
    total += i
  }
  return total
}

describe('detectCycles via init (property)', function () {
  it.prop([fc.integer({ min: 2, max: 6 }), fc.array(fc.boolean(), { minLength: 0, maxLength: 20 })], { numRuns: 100 })(
    'acyclic DAG init succeeds',
    async (nodeCount, mask) => {
      const edgeCount = maxAcyclicEdges(nodeCount)
      const edgeMask = mask.slice(0, edgeCount)
      while (edgeMask.length < edgeCount) {
        edgeMask.push(false)
      }

      const edges = buildAcyclicEdges(nodeCount, edgeMask)
      const di = buildDiFromEdges(edges)

      await expect(di.init()).resolves.toBeUndefined()
    },
  )

  it.prop([fc.integer({ min: 3, max: 6 })], { numRuns: 30 })(
    'closing a dependency chain with a back-edge creates a cycle',
    async nodeCount => {
      const keys = Array.from({ length: nodeCount }, (_, i) => `n${i}`)
      const chain = keys.slice(1)
        .map((key, i) => ({ from: key, to: keys[i]! }))
      const cyclic = addBackEdge(chain, keys[0]!, keys[nodeCount - 1]!)
      const di = buildDiFromEdges(cyclic)

      await expect(di.init()).rejects.toThrow(ErrCircularDependency)
    },
  )

  it('2-node mutual required dependency throws ErrCircularDependency', async function () {
    const di = buildDiFromEdges([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ])

    await expect(di.init()).rejects.toThrow(ErrCircularDependency)
  })

  it('optional closing edge does not trigger ErrCircularDependency at init', async function () {
    const di = new CaffeineIoC({ checks: { circularReferences: true }, decorators: false })
    di.bind(token<any>('a'), t => t
      .toFunction((_b: unknown) => ({}), [$i.optional(token<any>('b'))])
      .lazy())
    di.bind(token<any>('b'), t => t
      .toFunction((_a: unknown) => ({}), [token<any>('a')])
      .lazy())

    await expect(di.init()).resolves.toBeUndefined()
  })

  it('defer closing edge does not trigger ErrCircularDependency at init', async function () {
    const di = new CaffeineIoC({ checks: { circularReferences: true }, decorators: false })
    di.bind(token<any>('a'), t => t
      .toFunction(
        (_b: unknown) => ({}),
        [$i.defer(() => token<any>('b'))],
      ))
    di.bind(token<any>('b'), t => t
      .toFunction((_a: unknown) => ({}), [token<any>('a')]))

    await expect(di.init()).resolves.toBeUndefined()
  })
})
