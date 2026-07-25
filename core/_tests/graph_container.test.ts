import { describe, it, expect } from 'vitest'
import { CaffeineIoC } from '../container.js'
import { buildBindingGraph, graphToMarkdown, graphToMermaid, graphToDot, graphToJSON, graphToText } from '../graph.js'
import { Scopes } from '../scope.js'

class ServiceB {}
class ServiceC {}
class ServiceA {
  constructor(
    readonly b: ServiceB,
    readonly c: ServiceC,
  ) {}
}
class ServiceD {
  constructor(readonly a: ServiceA) {}
}

describe('graph functions with container as iterable', function () {
  it('buildBindingGraph includes user-registered bindings', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceA).toClass(ServiceA, [ServiceB, ServiceC])
    di.bind(ServiceB).toSelf()
    di.bind(ServiceC).toSelf()

    const graph = buildBindingGraph(di)
    const labels = graph.nodes.map(n => n.label)

    expect(labels).toContain('ServiceA')
    expect(labels).toContain('ServiceB')
    expect(labels).toContain('ServiceC')
  })

  it('graphToText shows node label and scope for single binding', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceB).toSelf()
      .lifetime(Scopes.TRANSIENT)

    const output = graphToText(di)

    expect(output).toContain('ServiceB')
    expect(output).toContain('transient')
  })

  it('graphToMarkdown shows injection edge when dependency registered', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceD).toClass(ServiceD, [ServiceA])
    di.bind(ServiceA).toClass(ServiceA, [ServiceB, ServiceC])
    di.bind(ServiceB).toSelf()
    di.bind(ServiceC).toSelf()

    const output = graphToMarkdown(di)

    expect(output).toContain('## Dependencies')
    expect(output).toContain('- ServiceD')
    expect(output).toContain('  - ServiceA')
    expect(output).toContain('- ServiceA')
    expect(output).toContain('  - ServiceB')
    expect(output).toContain('  - ServiceC')
  })

  it('graphToMermaid shows named-group edge for shared qualifier', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceA).toClass(ServiceA, [ServiceB, ServiceC])
      .names('handler')
    di.bind(ServiceB).toSelf()
      .names('handler')
    di.bind(ServiceC).toSelf()

    const output = graphToMermaid(di)

    expect(output).toContain('flowchart LR')
    expect(output).toContain('-.->')
    expect(output).toContain('handler')
  })

  it('graphToDot marks primary binding', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceB).toSelf()
      .primary()

    const output = graphToDot(di)

    expect(output).toContain('digraph bindings')
    expect(output).toContain('[primary]')
    expect(output).toContain('ServiceB')
  })

  it('graphToJSON serializes injection edges from container', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceA).toClass(ServiceA, [ServiceB, ServiceC])
    di.bind(ServiceB).toSelf()
    di.bind(ServiceC).toSelf()

    const parsed = JSON.parse(graphToJSON(di))
    const labels = parsed.nodes.map((n: { label: string }) => n.label)

    expect(labels).toContain('ServiceA')
    expect(labels).toContain('ServiceB')
    expect(labels).toContain('ServiceC')

    const injEdges = parsed.edges.filter((e: { kind: string }) => e.kind === 'injection')
    expect(injEdges).toHaveLength(2)
    expect(injEdges[0].meta).toBe('param[0]')
    expect(injEdges[1].meta).toBe('param[1]')
  })

  it('container Symbol.iterator and entries() produce same graph', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceA).toClass(ServiceA, [ServiceB, ServiceC])
    di.bind(ServiceB).toSelf()
    di.bind(ServiceC).toSelf()

    const fromIterator = buildBindingGraph(di)
    const fromEntries = buildBindingGraph(di.entries())

    expect(fromIterator.nodes.map(n => n.id)).toEqual(fromEntries.nodes.map(n => n.id))
    expect(fromIterator.edges).toHaveLength(fromEntries.edges.length)
  })
})
