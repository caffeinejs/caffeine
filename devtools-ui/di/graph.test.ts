import type { DependencyGraph } from '@caffeinejs/devtools'
import { describe, expect, it } from 'vitest'

import { drawGraph } from './graph.js'

function node(id: number, label: string): DependencyGraph['nodes'][number] {
  return { id, label, scopeID: '@caffeinejs/di:scope.singleton', names: [], labels: [], primary: false, lazy: false }
}

const graph: DependencyGraph = {
  nodes: [node(1, 'CheckoutService'), node(2, 'PaymentGateway')],
  edges: [{ fromID: 1, toID: 2, kind: 'injection', meta: 'param[0]' }],
  mermaid: '',
}

describe('drawGraph', () => {
  it('measures every label in Helvetica, the face the page sets it in, so each text fits the box drawn for it', async () => {
    const svg = await drawGraph(graph)
    // Graphviz writes its own name for a face it has the metrics of, and any other name as given, measured as Times.
    const faces = new Set([...svg.matchAll(/font-family="([^"]*)"/g)].map(([, face]) => face))

    expect([...faces]).toEqual(['Helvetica,sans-Serif'])
  })

  it('draws on no page of its own, so the panel behind it shows through in either theme', async () => {
    const svg = await drawGraph(graph)

    expect(svg).toMatch(/^<svg /)
    expect(svg).not.toContain('<polygon fill="white" stroke="none"')
  })
})
