import { describe, expect } from 'vitest'
import { it, fc } from '@fast-check/vitest'
import { buildBindingGraph, graphToJson, graphToDot, graphToMermaid } from '../../graph.js'
import { binding } from './helpers/binding_factory.js'

class NodeA {}
class NodeB {}
class NodeC {}

const NODE_CLASSES = [NodeA, NodeB, NodeC] as const

describe('buildBindingGraph (property)', function () {
  it.prop(
    [
      fc.integer({ min: 1, max: 8 }),
      fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 8 }),
      fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 0, maxLength: 4 }),
    ],
    { numRuns: 100 },
  )('node count matches binding count', (count, depIndices, sharedNames) => {
    const entries: [typeof NodeA, ReturnType<typeof binding>][] = []

    for (let i = 0; i < count; i++) {
      const clazz = NODE_CLASSES[i % NODE_CLASSES.length]!
      const names = i < sharedNames.length ? [sharedNames[i]!] : []
      const depClass = depIndices[i] !== undefined ? NODE_CLASSES[depIndices[i]! % NODE_CLASSES.length] : undefined
      const injections = depClass ? [{ key: depClass }] : []

      entries.push([clazz, binding(i + 1, { names, injections })])
    }

    const graph = buildBindingGraph(entries)
    expect(graph.nodes)
      .toHaveLength(count)
  })

  it.prop([fc.integer({ min: 1, max: 6 })], { numRuns: 50 })(
    'all edge endpoints reference existing node ids',
    count => {
      const entries: [typeof NodeA, ReturnType<typeof binding>][] = []

      for (let i = 0; i < count; i++) {
        const clazz = NODE_CLASSES[i % NODE_CLASSES.length]!
        const dep = i > 0 ? NODE_CLASSES[(i - 1) % NODE_CLASSES.length] : undefined
        entries.push([clazz, binding(i + 1, { injections: dep ? [{ key: dep }] : [] })])
      }

      const graph = buildBindingGraph(entries)
      const nodeIds = new Set(graph.nodes.map(n => n.id))

      for (const edge of graph.edges) {
        expect(nodeIds.has(edge.fromId))
          .toBe(true)
        expect(nodeIds.has(edge.toId))
          .toBe(true)
      }
    },
  )

  it.prop([fc.integer({ min: 2, max: 5 }), fc.string({ minLength: 1, maxLength: 8 })], { numRuns: 50 })(
    'N bindings sharing a name produce N-1 named-group edges',
    (count, name) => {
      const entries: [typeof NodeA, ReturnType<typeof binding>][] = []

      for (let i = 0; i < count; i++) {
        entries.push([NODE_CLASSES[i % NODE_CLASSES.length]!, binding(i + 1, { names: [name] })])
      }

      const graph = buildBindingGraph(entries)
      const groupEdges = graph.edges.filter(e => e.kind === 'named-group')

      expect(groupEdges)
        .toHaveLength(count - 1)
    },
  )

  it.prop([fc.integer({ min: 1, max: 4 })], { numRuns: 30 })('graphToJson preserves node and edge counts', count => {
    const entries: [typeof NodeA, ReturnType<typeof binding>][] = []

    for (let i = 0; i < count; i++) {
      const dep = i > 0 ? NODE_CLASSES[0] : undefined
      entries.push([NODE_CLASSES[i % NODE_CLASSES.length]!, binding(i + 1, { injections: dep ? [{ key: dep }] : [] })])
    }

    const graph = buildBindingGraph(entries)
    const parsed = JSON.parse(graphToJson(graph))

    expect(parsed.nodes)
      .toHaveLength(graph.nodes.length)
    expect(parsed.edges)
      .toHaveLength(graph.edges.length)
  })

  it.prop([fc.integer({ min: 1, max: 3 })], { numRuns: 20 })('serializers do not throw for valid graphs', count => {
    const entries: [typeof NodeA, ReturnType<typeof binding>][] = []

    for (let i = 0; i < count; i++) {
      entries.push([NODE_CLASSES[i % NODE_CLASSES.length]!, binding(i + 1)])
    }

    expect(() => graphToDot(entries)).not.toThrow()
    expect(() => graphToMermaid(entries)).not.toThrow()
    expect(() => JSON.parse(graphToJson(entries))).not.toThrow()
  })
})
